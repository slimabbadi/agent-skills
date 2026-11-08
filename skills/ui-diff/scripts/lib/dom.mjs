// DOM side: match the elements of two manifests, diff them into causes (style/text changes),
// layout effects (moved/resized) and added/removed elements; then explain pixel regions.
import { PROP_NAMES } from './browser.mjs';
import { CELL, cropDiffers } from './pixels.mjs';

// A child inherits these, so a parent's colour change would otherwise be repeated by every
// descendant. A child's diff is dropped when its parent shows the identical diff.
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-transform', 'text-align', 'visibility']);
// A moved/resized element only explains pixels when it is not much bigger than the region:
// otherwise <body> growing by 12px would "explain" every change on the page.
const LAYOUT_MAX_AREA_RATIO = 4;
// Share of a region's changed cells that must fall inside explaining boxes.
const EXPLAINED_COVERAGE = 0.8;
// Changed pixels just outside an element's box (shadows, anti-aliasing, the old position of
// shortened text) still count as that element's change.
const NEAR = CELL;

const area = (e) => e.w * e.h;
const rendered = (e) => e && e.s;

// ---- Matching ---------------------------------------------------------------------------

// Children are aligned like lines in a text diff: longest common subsequence on a strong
// signature (tag, id, test id, classes, own text), then leftovers inside each gap are paired
// in order by tag. Inserting a banner therefore leaves its siblings matched, and an element
// whose Tailwind classes changed still pairs with its old self (same tag, same gap).
const sig = (e) => `${e.tag}|${e.id}|${e.tid}|${e.cls}|${e.t}`;
function alignChildren(cb, ca) {
  const n = cb.length, m = ca.length, pairs = [];
  const gap = (gb, ga) => {
    let j = 0;
    for (const b of gb) {
      const k = ga.findIndex((a, idx) => idx >= j && a.tag === b.tag && (a.id || b.id ? a.id === b.id : true));
      if (k >= 0) { pairs.push([b, ga[k]]); j = k + 1; }
    }
  };
  if (n * m > 4_000_000) { gap(cb, ca); return pairs; }
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = sig(cb[i]) === sig(ca[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, gb = [], ga = [];
  while (i < n && j < m) {
    if (sig(cb[i]) === sig(ca[j])) { gap(gb, ga); gb = []; ga = []; pairs.push([cb[i++], ca[j++]]); }
    else if (L[i + 1][j] >= L[i][j + 1]) gb.push(cb[i++]);
    else ga.push(ca[j++]);
  }
  gap([...gb, ...cb.slice(i)], [...ga, ...ca.slice(j)]);
  return pairs;
}

function matchTrees(before, after) {
  const kids = (list) => {
    const m = new Map();
    for (const e of list) if (e.p >= 0) (m.get(e.p) ?? m.set(e.p, []).get(e.p)).push(e);
    return m;
  };
  const kb = kids(before), ka = kids(after), toAfter = new Map(), toBefore = new Map();
  const stack = before.length && after.length && before[0].tag === after[0].tag ? [[before[0], after[0]]] : [];
  while (stack.length) {
    const [b, a] = stack.pop();
    toAfter.set(b.i, a); toBefore.set(a.i, b);
    for (const pair of alignChildren(kb.get(b.i) ?? [], ka.get(a.i) ?? [])) stack.push(pair);
  }
  return { toAfter, toBefore };
}

// ---- Diff -------------------------------------------------------------------------------

export function diffDom(before, after, volatileProps = new Set()) {
  const { toAfter, toBefore } = matchTrees(before, after);
  const pairs = new Map(); // after index -> pair
  for (const a of after) {
    const b = toBefore.get(a.i);
    if (!rendered(a) || !rendered(b)) continue;
    const st = new Map();
    // Props that flicker between identical shots of one page are not evidence of a change.
    PROP_NAMES.forEach((n, i) => { if (a.s[i] !== b.s[i] && !volatileProps.has(`${a.l}|${n}`) && !volatileProps.has(`${b.l}|${n}`)) st.set(n, [b.s[i], a.s[i]]); });
    pairs.set(a.i, { a, b, st, text: a.t !== b.t ? [b.t, a.t] : null });
  }
  const causes = [], moved = [], resized = [];
  for (const d of pairs.values()) {
    const parent = pairs.get(d.a.p);
    const kept = [...d.st].filter(([n, v]) => {
      const pv = INHERITED.has(n) && parent?.st.get(n);
      return !(pv && pv[0] === v[0] && pv[1] === v[1]);
    });
    if (kept.length || d.text) causes.push({ label: d.a.l, a: d.a, b: d.b, diffs: kept, text: d.text });
    if (d.a.w !== d.b.w || d.a.h !== d.b.h) resized.push(d);
    else if (d.a.x !== d.b.x || d.a.y !== d.b.y) moved.push(d);
  }
  // Rendered on one side only: unmatched, or matched but without a box on the other side.
  // Report the top-most such element; its descendants come along by definition.
  const onlyIn = (list, other) => {
    const solo = new Set(list.filter((e) => rendered(e) && !rendered(other.get(e.i))).map((e) => e.i));
    return list.filter((e) => solo.has(e.i) && !solo.has(e.p));
  };
  const added = onlyIn(after, toBefore);
  const removed = onlyIn(before, toAfter);
  return { causes, moved, resized, added, removed, after: after.filter(rendered) };
}

// ---- Explaining pixel regions -----------------------------------------------------------

const near = (e, x, y) => x >= e.x - NEAR && x <= e.x + e.w + NEAR && y >= e.y - NEAR && y <= e.y + e.h + NEAR;
// Share of a region's changed cells that an explaining box covers, on either side.
function coverage(cells, boxesA, boxesB) {
  if (!cells.length) return 1;
  let hit = 0;
  for (const c of cells)
    if (c.a.some((y) => boxesA.some((e) => near(e, c.x, y))) || c.b.some((y) => boxesB.some((e) => near(e, c.x, y)))) hit++;
  return hit / cells.length;
}
const touches = (r, e) => r && r.left < e.x + e.w + NEAR && e.x - NEAR < r.left + r.width && r.top < e.y + e.h + NEAR && e.y - NEAR < r.top + r.height;

// Does a cause's element (before or after box) touch any changed pixel region?
export const touchesAny = (c, regions) => regions.some((g) => touches(g.a, c.a) || touches(g.b, c.b));

// Each region gets `why`: 'change' (style/text/added/removed elements cover its changed
// cells), 'layout' (moved/resized elements cover them, moved ones verified pixel-identical at
// their new position), or 'unexplained'. Unexplained regions are always shown in the image.
export function explain(regions, dom, B, A, volatileCells = new Set()) {
  const clip = (e, img) => {
    const left = Math.max(0, e.x), top = Math.max(0, e.y);
    return { left, top, width: Math.min(img.width, e.x + e.w) - left, height: Math.min(img.H, e.y + e.h) - top };
  };
  // A moved element explains pixels only if its content really is unchanged.
  const verifiedMoved = dom.moved.filter((d) => {
    const rb = clip(d.b, B), ra = clip(d.a, A);
    return rb.width > 0 && rb.height > 0 && rb.width === ra.width && rb.height === ra.height && !cropDiffers(B, rb, A, ra);
  });
  const causeA = [...dom.causes.map((c) => c.a), ...dom.added];
  const causeB = [...dom.causes.map((c) => c.b), ...dom.removed];
  for (const g of regions) {
    const size = (g.a ?? g.b).width * (g.a ?? g.b).height;
    const ca = causeA.filter((e) => touches(g.a, e)), cb = causeB.filter((e) => touches(g.b, e));
    // Resized media and background images rescale their whole content, so they explain
    // changed pixels anywhere inside them, however large they are.
    const layout = [...verifiedMoved, ...dom.resized].filter((d) => area(d.a) <= LAYOUT_MAX_AREA_RATIO * size || (dom.resized.includes(d) && scalesContent(d.a)));
    const la = layout.map((d) => d.a).filter((e) => touches(g.a, e)), lb = layout.map((d) => d.b).filter((e) => touches(g.b, e));
    const byCause = coverage(g.cells, ca, cb);
    const byAll = coverage(g.cells, [...ca, ...la], [...cb, ...lb]);
    // Volatile: every changed cell (after side) also flickered between identical shots of
    // one page. Checked after DOM/layout coverage, so a real DOM change there still wins.
    const vol = (c) => c.a.some((y) => volatileCells.has(`${c.x - (c.x % CELL)},${y - (y % CELL)}`));
    g.why = byAll >= EXPLAINED_COVERAGE ? (byCause > 0 ? 'change' : 'layout')
      : g.cells.length && g.cells.every(vol) ? 'volatile' : 'unexplained';
    g.label = smallestContaining(dom.after, g.a) ?? '(only in before)';
  }
  return regions;
}

const BG_IMAGE = PROP_NAMES.indexOf('background-image');
const scalesContent = (e) => ['img', 'video', 'canvas', 'svg', 'picture'].includes(e.tag) || (e.s[BG_IMAGE] && e.s[BG_IMAGE] !== 'none');

function smallestContaining(elements, r) {
  if (!r) return null;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null;
  for (const e of elements) if (cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h && (!best || area(e) < area(best))) best = e;
  return best?.l ?? null;
}

// ---- Text formatting --------------------------------------------------------------------

const hex2 = (n) => Number(n).toString(16).padStart(2, '0');
const short = (v) => {
  const s = String(v).replace(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/g,
    (_, r, g, b, a) => `#${hex2(r)}${hex2(g)}${hex2(b)}${a !== undefined && a !== '1' ? '/' + a : ''}`);
  // Tailwind's rounded-full is a huge radius (3.35544e+07px).
  const r = s.replace(/\d(\.\d+)?e\+\d+px/g, 'full');
  return r.length > 60 ? r.slice(0, 57) + '...' : r || '(none)';
};

// Causes grouped by identical change, e.g. three buttons with the same new background.
export function groupCauses(causes) {
  const groups = new Map();
  for (const c of causes) {
    const key = c.label + JSON.stringify(c.diffs) + JSON.stringify(c.text);
    (groups.get(key) ?? groups.set(key, []).get(key)).push(c);
  }
  return [...groups.values()];
}

export function describeCause(group) {
  const c = group[0], parts = [];
  if (c.text) parts.push(`text "${c.text[0]}" -> "${c.text[1]}"`);
  for (const [n, [from, to]] of c.diffs.slice(0, 4)) parts.push(`${n} ${short(from)} -> ${short(to)}`);
  if (c.diffs.length > 4) parts.push(`+${c.diffs.length - 4} more props`);
  const label = c.text ? c.label.replace(/ ".*"$/, '') : c.label;
  return `${label}${group.length > 1 ? ` x${group.length}` : ''}: ${parts.join('; ')}`;
}

export function describeLayout(dom) {
  const out = [];
  if (dom.moved.length) {
    const by = new Map();
    for (const d of dom.moved) { const k = `${d.a.x - d.b.x},${d.a.y - d.b.y}`; by.set(k, (by.get(k) || 0) + 1); }
    const top = [...by].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([k, n]) => `${n} by (${k})`).join(', ');
    out.push(`${dom.moved.length} element(s) moved: ${top}${by.size > 3 ? `, +${by.size - 3} other offsets` : ''}`);
  }
  if (dom.resized.length) {
    const top = dom.resized.slice().sort((p, q) => area(q.a) - area(p.a)).slice(0, 3)
      .map((d) => `${d.a.l.replace(/ ".*"$/, '')} ${d.b.w}x${d.b.h}->${d.a.w}x${d.a.h}`).join(', ');
    out.push(`${dom.resized.length} resized: ${top}${dom.resized.length > 3 ? ', ...' : ''}`);
  }
  return out;
}
