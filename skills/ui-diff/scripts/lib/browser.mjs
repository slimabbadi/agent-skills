// Capture: drive agent-browser, stabilise the page, take the screenshot and the element manifest.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharpLib from './sharp.mjs';

// On Windows `agent-browser` is a .CMD shim that execFile can't spawn without a shell, and a
// shell would mangle the JavaScript we pass to `eval`. Call the shim's target script with node.
function resolveAgentBrowser() {
  if (process.platform !== 'win32') return ['agent-browser', []];
  const shim = execFileSync('where', ['agent-browser.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  const js = fs.readFileSync(shim, 'utf8').match(/"%~dp0\\([^"]+\.js)"/)?.[1];
  if (!js) throw new Error(`cannot find agent-browser.js in ${shim}`);
  return [process.execPath, [path.join(path.dirname(shim), js)]];
}

export function makeBrowser(session) {
  const [bin, pre] = resolveAgentBrowser();
  const ab = (...args) => execFileSync(bin, [...pre, '--session', session, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
  // agent-browser prints the eval result JSON-encoded; returning a JSON string keeps types intact.
  const evalJson = (expr) => JSON.parse(JSON.parse(ab('eval', `(async () => JSON.stringify(await (${expr})))()`).trim()));
  return { ab, evalJson };
}

// Computed styles recorded per element. Order matters: manifests store values positionally.
export const PROPS = [
  'color', 'background-color', 'background-image', 'border-top-width', 'border-top-style',
  'border-top-color', 'border-radius', 'box-shadow', 'outline-style', 'font-family', 'font-size',
  'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform',
  'text-decoration-line', 'text-align', 'padding', 'margin', 'gap', 'display', 'visibility',
  'opacity', 'transform', 'filter', 'object-fit',
];
// Last slot after PROPS: an <img>'s current source file name.
export const PROP_NAMES = [...PROPS, 'src'];

// Runs in the page. One entry per element, in document order (parents first): i = index,
// p = parent index (-1 for the root), tag/id/tid/cls = identity used to match elements across
// captures, l = label, x/y/w/h = box in page (or --selector element) coordinates, t = own
// text, s = styles (null when the element has no box, e.g. display:none).
const manifestJs = (selector) => `(() => {
  const P = ${JSON.stringify(PROPS)};
  const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'BR']);
  const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.documentElement'};
  if (!root) return [];
  const rb = root.getBoundingClientRect();
  const ox = ${selector ? 'rb.left' : '-scrollX'}, oy = ${selector ? 'rb.top' : '-scrollY'};
  const out = [];
  const walk = (el, p) => {
    if (SKIP.has(el.tagName)) return;
    const i = out.length, r = el.getBoundingClientRect(), shown = r.width > 0 || r.height > 0;
    let t = '';
    for (const c of el.childNodes) if (c.nodeType === 3) t += c.data;
    t = t.replace(/\\s+/g, ' ').trim().slice(0, 80);
    const clsAll = typeof el.className === 'string' ? el.className.trim() : '';
    const cls = clsAll.split(/\\s+/)[0];
    const txt = (t || (el.children.length <= 3 ? el.textContent.replace(/\\s+/g, ' ').trim() : '')).slice(0, 30);
    let s = null;
    if (shown) {
      const cs = getComputedStyle(el);
      s = P.map((p) => cs.getPropertyValue(p));
      s.push(el.tagName === 'IMG' ? (el.currentSrc || '').split('/').pop().slice(0, 80) : '');
    }
    out.push({ i, p, tag: el.tagName.toLowerCase(), id: el.id, tid: el.getAttribute('data-testid') || '', cls: clsAll,
      l: el.tagName.toLowerCase() + (el.id ? '#' + el.id : cls ? '.' + cls : '') + (txt ? ' "' + txt + '"' : ''),
      x: Math.round(r.left - ox), y: Math.round(r.top - oy), w: Math.round(r.width), h: Math.round(r.height), t, s });
    for (const c of el.children) walk(c, i);
  };
  walk(root, -1);
  return out;
})()`;

// Opens the page, makes it render deterministically, then writes <out>.png and <out>.json.
export async function capture({ ab, evalJson }, url, opt, pngPath, jsonPath, phase = () => {}) {
  ab('set', 'viewport', String(opt.width), String(opt.height));
  // Pin theme and ask for reduced motion: motion libraries often drive colours and transforms
  // from JS/scroll state, which `animation:none` alone does not stop.
  ab('set', 'media', opt.theme || 'light', 'reduced-motion');
  ab('open', url); phase('open');
  // Not networkidle: dev-server HMR sockets, maps and analytics keep the network busy, so it
  // often only ends at its 25s timeout. Wait for load, then for what actually paints.
  ab('wait', '--load', 'load'); phase('load');
  // Park the pointer in a corner so no hover state differs between captures.
  ab('mouse', 'move', '0', '0');
  // Lazy images below the fold never load in an unscrolled page, so they would show up blank
  // in the full-page shot: load them eagerly, then wait for fonts and every image to decode
  // (capped at 10s so a broken image cannot hang the run).
  evalJson(`(async () => {
    document.querySelectorAll('img[loading=lazy]').forEach((i) => { i.loading = 'eager'; });
    await Promise.race([
      Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    return true;
  })()`); phase('fonts+images');
  // Freeze CSS animations, transitions and the caret. Web Animations API and JS-started
  // animations ignore the stylesheet, so also pause every animation at time 0: both captures
  // then land on the same frame.
  evalJson(`(() => {
    const s = document.createElement('style');
    // nextjs-portal: the Next.js dev-tools badge ("N" / "4 Issues"), dev-server only and live.
    s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}nextjs-portal{display:none!important}';
    document.head.appendChild(s);
    const pause = () => document.getAnimations().forEach((a) => { try { a.pause(); a.currentTime = 0; } catch {} });
    pause();
    // Motion code can start new animations later (e.g. when the full-page capture brings an
    // element "into view"); keep pausing them.
    setInterval(pause, 16);
    return true;
  })()`);
  // Fixed-position elements (header, cookie banner) are placed relative to the viewport, so a
  // full-page capture puts them wherever the viewport happens to be. Pin each one as absolute
  // at its current page position: still visible and compared, but stable. Re-run before every
  // shot because overlays such as consent banners mount late. --keep-fixed disables this.
  const pinFixed = () => (opt.keepFixed ? [] : evalJson(`(() => {
    const pinned = [];
    for (const e of document.querySelectorAll('body *')) {
      if (e.dataset.uiDiffPinned || getComputedStyle(e).position !== 'fixed') continue;
      const r = e.getBoundingClientRect();
      if (!r.height) continue;
      e.dataset.uiDiffPinned = '1';
      for (const [k, v] of [['position', 'absolute'], ['top', r.top + scrollY + 'px'], ['left', r.left + scrollX + 'px'],
        ['bottom', 'auto'], ['right', 'auto'], ['width', r.width + 'px'], ['height', r.height + 'px'], ['margin', '0']])
        e.style.setProperty(k, v, 'important');
      const t = (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
      pinned.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (t ? ' "' + t + '"' : ''));
    }
    return pinned;
  })()`));
  // --hide "sel1,sel2": elements the caller wants out of the comparison (consent banners,
  // live widgets). Hidden, not removed, so layout is unchanged; re-applied before every shot
  // because such elements often mount late.
  const hideSelected = () => (opt.hide ? evalJson(`(() => {
    const n = document.querySelectorAll(${JSON.stringify(opt.hide)});
    n.forEach((e) => e.style.setProperty('visibility', 'hidden', 'important'));
    return n.length;
  })()`) : 0);
  let hiddenCount = hideSelected();
  const pinnedFixed = pinFixed();
  // Settle: take shots until two in a row are identical (at most 3), and take the manifest
  // from the settled page. Late-mounting content (streamed sections, consent banners) and
  // scroll/intersection handlers fired by the full-page render otherwise leak into the diff.
  // Whatever still differs between consecutive shots of the same page is recorded as
  // volatile: 16px cells of pixels, and element styles (by label) that changed.
  const shoot = (p) => ab('screenshot', ...(opt.selector ? [opt.selector] : ['--full']), p);
  const warm = pngPath.replace(/\.png$/, '.settle.png');
  shoot(warm);
  let manifest = null, settled = false, tries = 0;
  const volatileCells = new Set(), volatileProps = new Set();
  while (!settled && tries < 3) {
    tries++;
    hiddenCount = Math.max(hiddenCount, hideSelected());
    pinnedFixed.push(...pinFixed());
    const next = evalJson(manifestJs(opt.selector));
    if (manifest) for (const v of styleChanges(manifest, next)) volatileProps.add(v);
    manifest = next;
    shoot(pngPath);
    const cells = await changedCells(warm, pngPath);
    settled = cells !== null && cells.length === 0;
    if (cells) cells.forEach((c) => volatileCells.add(c));
    if (!settled) fs.copyFileSync(pngPath, warm);
  }
  fs.rmSync(warm, { force: true });
  phase(`settled=${settled} after ${tries} shot(s), manifest ${manifest.length} elements, ${volatileCells.size} volatile cells`);
  fs.writeFileSync(jsonPath, JSON.stringify({ pinnedFixed, settled, hidden: opt.hide ? `${opt.hide} (${hiddenCount})` : '', volatileCells: [...volatileCells], volatileProps: [...volatileProps], elements: manifest }));
  return { pinnedFixed, settled, hidden: opt.hide ? `${opt.hide} (${hiddenCount} element(s))` : '' };
}

// Same page, consecutive manifests: element order is identical, so compare by index.
export function styleChanges(prev, next) {
  const out = [];
  if (prev.length !== next.length) return out;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i], b = next[i];
    if (!a.s || !b.s || a.l !== b.l) continue;
    PROP_NAMES.forEach((n, k) => { if (a.s[k] !== b.s[k]) out.push(`${b.l}|${n}`); });
  }
  return out;
}

// 16px cells ("x,y" of the cell origin) where two shots differ by more than 2/255; null when
// the sizes differ (the page itself is still changing).
const VOLATILE_CELL = 16;
export async function changedCells(p, q) {
  const [a, b] = await Promise.all([p, q].map((f) => sharpLib(f).raw().toBuffer({ resolveWithObject: true })));
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return null;
  if (a.data.equals(b.data)) return [];
  const { width: W, height: H, channels: C } = a.info, cells = new Set();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * C;
    if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > 2)
      cells.add(`${x - (x % VOLATILE_CELL)},${y - (y % VOLATILE_CELL)}`);
  }
  return [...cells];
}
