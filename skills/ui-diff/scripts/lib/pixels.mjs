// Pixel side: align rows like a text diff, then find changed regions inside each hunk.

export const CELL = 16;     // grid cell size for grouping changed pixels into regions
export const PAD = 12;      // context around each region
const MAX_EDITS = 1500;     // row-diff budget; beyond it the pages are treated as one changed band
const MIN_MOVE_ROWS = 8;    // shorter identical runs are not worth a "moved" line
// Change hunks separated by fewer identical rows than this are merged. Blank rows (padding,
// whitespace) all hash alike, so the row diff can pair them arbitrarily and split one grown
// element into a fake "removed" band plus a change; merging restores one hunk that the
// top/bottom-aligned comparison handles.
const MERGE_GAP = 32;
// A pixel counts as changed when any channel moves by more than JITTER/255. Kept tiny on
// purpose: a summed-RGB tolerance of 30 hides design-token tweaks like #1d4ed8 -> #2452df.
// Same browser + same machine renders deterministically, so real noise belongs to the
// stabilisation step, not to a loose threshold.
export const JITTER = 2;
// pixelmatch's default perceptual threshold (0.1) as a squared YIQ distance. Regions whose
// largest change is below it are reported as "subtle": hard to see, so the text must carry it.
const SUBTLE_YIQ = 35215 * 0.1 * 0.1;

// Image as raw RGBA, padded on the right to width W (heights stay their own).
export async function load(sharp, f, W) {
  const m = await sharp(f).metadata();
  const data = await sharp(f).ensureAlpha().extend({ right: W - m.width, background: '#ff00ff' }).raw().toBuffer();
  return { data, W, H: m.height, f, width: m.width };
}

export const maxDelta = (a, i, b, j) =>
  Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2]));
const hex = (d, i) => '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
// pixelmatch's YIQ colour distance (squared).
function yiq(a, i, b, j) {
  const dr = a[i] - b[j], dg = a[i + 1] - b[j + 1], db = a[i + 2] - b[j + 2];
  const y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
  const ii = dr * 0.59597799 - dg * 0.2741761 - db * 0.32180189;
  const q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
  return 0.5053 * y * y + 0.299 * ii * ii + 0.1957 * q * q;
}

export const box = (left, top, right, bottom, W, H) => {
  const l = Math.max(0, Math.round(left)), t = Math.max(0, Math.round(top));
  return { left: l, top: t, width: Math.max(1, Math.min(W, Math.round(right)) - l), height: Math.max(1, Math.min(H, Math.round(bottom)) - t) };
};

// ---- Row alignment ----------------------------------------------------------------------

function rowHashes({ data, W, H }) {
  const out = new Array(H), n = W * 4;
  for (let y = 0; y < H; y++) {
    let h1 = 2166136261, h2 = 0;
    for (let i = y * n, e = i + n; i < e; i++) { h1 = Math.imul(h1 ^ data[i], 16777619); h2 = (h2 * 31 + data[i]) | 0; }
    out[y] = `${h1 >>> 0}:${h2}`;
  }
  return out;
}

// Myers diff over row hashes. Returns ops from top to bottom: '=' (row kept, maybe moved),
// '-' (before row removed), '+' (after row inserted); null when more than MAX_EDITS edits.
function myers(A, B, eq = (x, y) => A[x] === B[y]) {
  const N = A.length, M = B.length, off = N + M + 1, trace = [];
  const v = new Int32Array(2 * off + 2);
  for (let d = 0; d <= Math.min(N + M, MAX_EDITS); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && eq(x, y)) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, N, M, off);
    }
  }
  return null;
}
function backtrack(trace, N, M, off) {
  const ops = []; let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const pk = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const px = v[off + pk], py = px - pk;
    while (x > px && y > py) { ops.push('='); x--; y--; }
    if (d > 0) ops.push(x === px ? '+' : '-');
    x = px; y = py;
  }
  return ops.reverse();
}

// Ops -> identical runs {b0, a0, len} and change hunks {b0, b1, a0, a1}.
function hunksFrom(ops) {
  const runs = [], hunks = []; let bi = 0, ai = 0, h = null;
  for (const op of ops) {
    if (op === '=') {
      if (h) { hunks.push(h); h = null; }
      const last = runs.at(-1);
      if (last && last.b0 + last.len === bi && last.a0 + last.len === ai) last.len++;
      else runs.push({ b0: bi, a0: ai, len: 1 });
      bi++; ai++;
    } else {
      h ??= { b0: bi, b1: bi, a0: ai, a1: ai };
      if (op === '-') { h.b1++; bi++; } else { h.a1++; ai++; }
    }
  }
  if (h) hunks.push(h);
  const merged = [];
  for (const k of hunks) {
    const prev = merged.at(-1);
    if (prev && k.b0 - prev.b1 < MERGE_GAP && k.a0 - prev.a1 < MERGE_GAP) { prev.b1 = k.b1; prev.a1 = k.a1; }
    else merged.push({ ...k });
  }
  // Runs swallowed by a merge are no longer "identical, moved".
  const inHunk = (r) => merged.some((k) => r.b0 >= k.b0 && r.b0 + r.len <= k.b1);
  return { runs: runs.filter((r) => !inHunk(r)), hunks: merged };
}

// ---- Regions ----------------------------------------------------------------------------

// Connected components of changed 16px cells (gaps up to 2 cells bridged) -> pixel boxes.
function components(mask, W, T) {
  const cols = Math.ceil(W / CELL), rows = Math.ceil(T / CELL), hot = new Uint8Array(cols * rows);
  for (let y = 0; y < T; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) hot[((y / CELL) | 0) * cols + ((x / CELL) | 0)] = 1;
  const seen = new Uint8Array(cols * rows), boxes = [];
  for (let c = 0; c < hot.length; c++) {
    if (!hot[c] || seen[c]) continue;
    const bx = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 }, stack = [c], cells = []; seen[c] = 1;
    while (stack.length) {
      const k = stack.pop(), cx = k % cols, cy = (k / cols) | 0;
      cells.push({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 }); // centre, band coordinates
      bx.x0 = Math.min(bx.x0, cx); bx.y0 = Math.min(bx.y0, cy); bx.x1 = Math.max(bx.x1, cx); bx.y1 = Math.max(bx.y1, cy);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx, ny = cy + dy, n = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && hot[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    boxes.push({ x0: bx.x0 * CELL, y0: bx.y0 * CELL, x1: Math.min(W, (bx.x1 + 1) * CELL), y1: Math.min(T, (bx.y1 + 1) * CELL), cells });
  }
  return boxes;
}

// Columns of a band that differ from the band's left edge: trims a full-width inserted
// banner down to its content.
function contentColumns({ data, W }, y0, y1) {
  let lo = W, hi = -1;
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++)
    if (maxDelta(data, (y * W + x) * 4, data, y * W * 4) > JITTER) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return hi < 0 ? [0, W] : [lo, hi + 1];
}

// Main before->after colour pair among changed pixels, and whether the change is subtle.
export function colourStats(B, rb, A, ra) {
  const pairs = new Map(); let maxYiq = 0, total = 0;
  const h = Math.min(rb.height, ra.height), w = Math.min(rb.width, ra.width);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((rb.top + y) * B.W + rb.left + x) * 4, j = ((ra.top + y) * A.W + ra.left + x) * 4;
    if (maxDelta(B.data, i, A.data, j) <= JITTER) continue;
    const k = hex(B.data, i) + ' -> ' + hex(A.data, j); pairs.set(k, (pairs.get(k) || 0) + 1); total++;
    maxYiq = Math.max(maxYiq, yiq(B.data, i, A.data, j));
  }
  let colour = '', n = 0;
  for (const [k, c] of pairs) if (c > n) { n = c; colour = k; }
  return { colour, colourShare: total ? n / total : 0, subtle: total > 0 && maxYiq < SUBTLE_YIQ, changedPx: total };
}

// One hunk -> regions {kind, b: rect|null, a: rect|null, ...stats}. Rows of the taller band
// are compared with the shorter band both top-aligned and bottom-aligned; a pixel is changed
// only if it differs under both. So content that merely sits above or below a grown element
// (a card that got 4px taller) is not flagged, while the element itself is.
function hunkRegions(B, A, h, stats) {
  const hb = h.b1 - h.b0, ha = h.a1 - h.a0, W = B.W;
  if (hb === 0 || ha === 0) {
    const [img, y0, y1, kind] = ha ? [A, h.a0, h.a1, 'inserted'] : [B, h.b0, h.b1, 'removed'];
    const [x0, x1] = contentColumns(img, y0, y1);
    stats.changed += (x1 - x0) * (y1 - y0);
    const r = box(x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD, W, img.H);
    const cells = [];
    for (let y = y0 + CELL / 2; y < y1 + CELL / 2; y += CELL) for (let x = x0 + CELL / 2; x < x1 + CELL / 2; x += CELL)
      cells.push(kind === 'inserted' ? { x, a: [Math.min(y, y1 - 1)], b: [] } : { x, a: [], b: [Math.min(y, y1 - 1)] });
    return [{ kind, b: kind === 'removed' ? r : null, a: kind === 'inserted' ? r : null, cells }];
  }
  const [Tl, Sh, t0, s0, T, S] = ha >= hb ? [A, B, h.a0, h.b0, ha, hb] : [B, A, h.b0, h.a0, hb, ha];
  const mask = new Uint8Array(W * T), dy = T - S;
  for (let y = 0; y < T; y++) for (let x = 0; x < W; x++) {
    const i = ((t0 + y) * W + x) * 4;
    const top = y < S ? maxDelta(Tl.data, i, Sh.data, ((s0 + y) * W + x) * 4) : 255;
    const bot = y - dy >= 0 ? maxDelta(Tl.data, i, Sh.data, ((s0 + y - dy) * W + x) * 4) : 255;
    const d = Math.min(top, bot);
    if (d > JITTER) { mask[y * W + x] = 1; stats.changed++; } else if (d > 0) stats.jitter++;
  }
  return components(mask, W, T).map((c) => {
    const rt = box(c.x0 - PAD, t0 + c.y0 - PAD, c.x1 + PAD, t0 + c.y1 + PAD, W, Tl.H);
    // Same columns in the shorter band, rows covering both alignments.
    const sy0 = Math.max(0, c.y0 - dy), sy1 = Math.max(sy0 + 1, Math.min(S, c.y1));
    const rs = box(c.x0 - PAD, s0 + sy0 - PAD, c.x1 + PAD, s0 + sy1 + PAD, W, Sh.H);
    const [b, a] = Tl === A ? [rs, rt] : [rt, rs];
    // Each changed cell in both coordinate systems; the shorter side has two candidate rows
    // (top- and bottom-aligned).
    const cells = c.cells.map(({ x, y }) => {
      const tall = [t0 + y], short = [s0 + Math.min(y, S - 1), s0 + Math.max(0, y - dy)];
      return Tl === A ? { x, a: tall, b: short } : { x, a: short, b: tall };
    });
    return { kind: 'changed', b, a, cells, ...colourStats(B, b, A, a) };
  });
}

// Whole pixel comparison: moves (identical runs at a new offset) and changed regions.
export function diffPixels(B, A) {
  // Rows are equal when their hashes match or every pixel is within JITTER: sub-visible
  // rendering noise must not break the alignment.
  const hb = rowHashes(B), ha = rowHashes(A), n = B.W * 4;
  const eq = (x, y) => {
    if (hb[x] === ha[y]) return true;
    for (let i = x * n, j = y * n, e = i + n; i < e; i += 4, j += 4) if (maxDelta(B.data, i, A.data, j) > JITTER) return false;
    return true;
  };
  const ops = myers(hb, ha, eq);
  // Over budget: compare the pages as one band (still top/bottom-aligned inside the hunk).
  const { runs, hunks } = ops ? hunksFrom(ops) : { runs: [], hunks: [{ b0: 0, b1: B.H, a0: 0, a1: A.H }] };
  const stats = { changed: 0, jitter: 0 };
  const regions = hunks.flatMap((h) => hunkRegions(B, A, h, stats));
  const moves = new Map();
  for (const r of runs) if (r.a0 !== r.b0 && r.len >= MIN_MOVE_ROWS) {
    const dy = r.a0 - r.b0, m = moves.get(dy);
    if (m) { m.rows += r.len; m.b1 = r.b0 + r.len; } else moves.set(dy, { b0: r.b0, b1: r.b0 + r.len, rows: r.len });
  }
  return { regions, moves, stats, aligned: !!ops };
}

// Changed pixels between two equally sized crops (for verifying that a moved element is
// pixel-identical at its new position).
export function cropDiffers(B, rb, A, ra) {
  if (rb.width !== ra.width || rb.height !== ra.height) return true;
  let n = 0;
  for (let y = 0; y < rb.height; y++) for (let x = 0; x < rb.width; x++) {
    const i = ((rb.top + y) * B.W + rb.left + x) * 4, j = ((ra.top + y) * A.W + ra.left + x) * 4;
    if (maxDelta(B.data, i, A.data, j) > JITTER && ++n > Math.max(4, rb.width * rb.height * 0.001)) return true;
  }
  return false;
}
