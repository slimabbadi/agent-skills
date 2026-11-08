// Review image: choose tiles (before | after crops), fit them into an image-token budget.
const GAP = 6;
const TILE_PAD = 8;
// An element box more than this many times larger than its changed pixels is cropped to
// them (a full-width banner whose content is 200px wide); smaller boxes keep their context.
const CROP_TO_CHANGE_RATIO = 4;
const MIN_SCALE = 0.5;       // below this, text in a crop stops being legible

// Anthropic image cost: ceil(w/28)*ceil(h/28) after the API downscales the long edge to 1568px.
export const imgTokens = (w, h) => {
  const s = Math.min(1, 1568 / Math.max(w, h));
  return Math.ceil((w * s) / 28) * Math.ceil((h * s) / 28);
};

const rectOf = (e, img) => {
  const left = Math.max(0, e.x - TILE_PAD), top = Math.max(0, e.y - TILE_PAD);
  return { left, top, width: Math.max(1, Math.min(img.width, e.x + e.w + TILE_PAD) - left), height: Math.max(1, Math.min(img.H, e.y + e.h + TILE_PAD) - top) };
};
const hits = (r, q) => r.left < q.left + q.width && q.left < r.left + r.width && r.top < q.top + q.height && q.top < r.top + r.height;
const within = (r, q) => r.left >= q.left && r.top >= q.top && r.left + r.width <= q.left + q.width && r.top + r.height <= q.top + q.height;
const bbox = (rs) => {
  const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top));
  return { left: l, top: t, width: Math.max(...rs.map((r) => r.left + r.width)) - l, height: Math.max(...rs.map((r) => r.top + r.height)) - t };
};
const intersect = (r, q) => {
  const l = Math.max(r.left, q.left), t = Math.max(r.top, q.top);
  const w = Math.min(r.left + r.width, q.left + q.width) - l, h = Math.min(r.top + r.height, q.top + q.height) - t;
  return w > 0 && h > 0 ? { left: l, top: t, width: w, height: h } : r;
};

// Tile order = priority: unexplained regions first (never explained away), then one tile per
// distinct DOM change that produced visible pixels, then added/removed elements; layout-only
// regions only with --show all. Tiles nested in an earlier tile are skipped.
export function planTiles({ regions, groups, dom, B, A, showAll }) {
  const tiles = [];
  for (const g of regions) if (g.why === 'unexplained') tiles.push({ b: g.b, a: g.a, title: `unexplained: ${g.label}` });
  const visible = regions.filter((g) => g.why !== 'unexplained');
  const sideBox = (e, img, side) => {
    let r = rectOf(e, img);
    const touching = visible.map((g) => g[side]).filter((q) => q && hits(r, q));
    if (!touching.length) return null;
    const bb = bbox(touching);
    if (r.width * r.height > CROP_TO_CHANGE_RATIO * bb.width * bb.height) r = intersect(r, bb);
    return r;
  };
  const causeTiles = groups.map((grp) => {
    const c = grp[0], b = sideBox(c.b, B, 'b'), a = sideBox(c.a, A, 'a');
    return b || a ? { b, a, title: `change: ${c.label}` } : null;
  }).filter(Boolean).sort((p, q) => (p.a ?? p.b).width * (p.a ?? p.b).height - (q.a ?? q.b).width * (q.a ?? q.b).height);
  tiles.push(...causeTiles);
  for (const e of dom.added) { const a = sideBox(e, A, 'a'); if (a) tiles.push({ b: null, a, title: `added: ${e.l}` }); }
  for (const e of dom.removed) { const b = sideBox(e, B, 'b'); if (b) tiles.push({ b, a: null, title: `removed: ${e.l}` }); }
  if (showAll) for (const g of regions) if (g.why === 'layout') tiles.push({ b: g.b, a: g.a, title: `layout: ${g.label}` });
  const kept = [];
  for (const t of tiles) {
    const nested = kept.some((k) => ['a', 'b'].every((s) => !t[s] || (k[s] && (within(t[s], k[s]) || within(k[s], t[s])))));
    if (!nested) kept.push(t);
  }
  return kept;
}

// Stacked layout: before crops in the left column, after crops in the right; a column
// disappears when no tile uses it.
function layout(tiles, s = 1) {
  const sz = (r) => (r ? { w: Math.max(1, Math.round(r.width * s)), h: Math.max(1, Math.round(r.height * s)) } : { w: 0, h: 0 });
  const wB = Math.max(0, ...tiles.map((t) => sz(t.b).w)), wA = Math.max(0, ...tiles.map((t) => sz(t.a).w));
  let y = 0; const pos = [];
  for (const t of tiles) { pos.push(y); y += Math.max(sz(t.b).h, sz(t.a).h) + GAP; }
  const w = wB + wA + (wB && wA ? GAP : 0), h = Math.max(1, y - GAP);
  return { w, h, wB, pos, sz, tokens: imgTokens(w, h) };
}

// Greedy fit under the token budget, in priority order. A first tile that alone is over
// budget is scaled down (not below MIN_SCALE) rather than dropped.
export function fitTiles(tiles, budget) {
  const shown = [], skipped = [];
  for (const t of tiles) (layout([...shown, t]).tokens <= budget ? shown : skipped).push(t);
  // Dropping a tile loses evidence; shrinking all of them a little (text stays legible down
  // to ~75%) is usually the better trade.
  if (skipped.length && shown.length) {
    for (let s = 0.95; s >= 0.75; s -= 0.05) if (layout(tiles, s).tokens <= budget) return { shown: tiles, skipped: [], scale: s };
  }
  if (shown.length || !tiles.length) return { shown, skipped, scale: 1 };
  // Tile rounding makes token cost a step function of size, so search the scale directly.
  const first = tiles[0];
  let s = 1;
  while (s > MIN_SCALE && layout([first], s).tokens > budget) s = Math.max(MIN_SCALE, s - 0.05);
  return { shown: [first], skipped: tiles.slice(1), scale: s };
}

export async function renderTiles(sharp, tiles, scale, B, A, out) {
  const L = layout(tiles, scale), comps = [];
  const crop = async (img, r) => {
    const buf = await sharp(img.f).extract(r).toBuffer();
    return scale === 1 ? buf : sharp(buf).resize(Math.max(1, Math.round(r.width * scale))).toBuffer();
  };
  for (const [i, t] of tiles.entries()) {
    if (t.b) comps.push({ input: await crop(B, t.b), left: 0, top: L.pos[i] });
    if (t.a) comps.push({ input: await crop(A, t.a), left: L.wB ? L.wB + GAP : 0, top: L.pos[i] });
  }
  await sharp({ create: { width: L.w, height: L.h, channels: 3, background: '#ff00ff' } }).composite(comps).png().toFile(out);
  return L;
}
