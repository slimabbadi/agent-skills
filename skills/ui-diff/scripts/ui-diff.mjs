#!/usr/bin/env node
// ui-diff: token-cheap before/after UI comparison for agents.
//
//   node ui-diff.mjs baseline <url> [options]
//   node ui-diff.mjs check    <url> [options]
//
// Options (defaults can live in ./.ui-diff.json; flags win):
//   --name n (baseline slot, default "default"), --selector css (one element only),
//   --width 1280 --height 800 (viewport), --theme light|dark, --budget 400 (max image tokens),
//   --show all (also show regions explained only by layout), --keep-fixed (leave
//   position:fixed elements unpinned), --hide "css,css" (hide elements such as a consent
//   banner; always reported), --reuse (re-diff the saved after capture instead of
//   capturing again).
//
// Each capture saves a full-page screenshot plus an element manifest (box, text, computed
// styles). `check` then reports, as text:
//   - DOM changes (style/text edits, added/removed elements): the causes;
//   - layout effects (moved/resized elements) and pixel moves (rows shifted, identical);
//   - pixel regions no DOM change explains.
// It writes ONE review image only when something visible changed, holding crops of the
// changed elements and every unexplained region (before | after), within the token budget.
// Nothing reaches the model unless the agent reads that image.
//
// Exit codes: 0 = no visual change, 1 = change found, 2 = usage or runtime error.
import fs from 'node:fs';
import path from 'node:path';
import { makeBrowser, capture, changedCells, styleChanges } from './lib/browser.mjs';
import { load, diffPixels } from './lib/pixels.mjs';
import { diffDom, explain, groupCauses, describeCause, describeLayout, touchesAny } from './lib/dom.mjs';
import { imgTokens, planTiles, fitTiles, renderTiles } from './lib/report.mjs';

// Node's own crash code is 1, which would read as "change found", so map every error to 2.
// The browser session is closed on every exit path.
let browser = null;
const finish = (code) => { try { browser?.ab('close'); } catch { /* already gone */ } process.exit(code); };
const die = (e) => { console.error(e?.message ?? e); finish(2); };
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

const { default: sharp } = await import('./lib/sharp.mjs');

const [mode, url, ...rest] = process.argv.slice(2);
const opt = { name: 'default', width: 1280, height: 800, selector: '', theme: 'light', budget: 400, show: '', hide: '', reuse: false, keepFixed: false };
// Project defaults, e.g. { "hide": "#cookie-banner", "width": 1440 }.
if (fs.existsSync('.ui-diff.json')) Object.assign(opt, JSON.parse(fs.readFileSync('.ui-diff.json', 'utf8')));
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, '');
  if (k === 'reuse') opt.reuse = true;
  else if (k === 'keep-fixed') opt.keepFixed = true;
  else opt[k] = rest[++i];
}
if (!['baseline', 'check'].includes(mode) || !url) {
  console.error(`usage: ui-diff.mjs baseline|check <url> [options]
  --name <slug>        baseline slot (default "default")
  --selector <css>     compare one element instead of the full page
  --width/--height <n> viewport (default 1280x800)
  --theme light|dark   prefers-color-scheme (default light)
  --hide "<css,css>"   hide elements (consent banners, live widgets); always reported
  --keep-fixed         leave position:fixed elements unpinned
  --budget <n>         max image tokens for the review image (default 400)
  --show all           also show regions explained only by layout
  --reuse              re-diff the saved after-capture without capturing again
Defaults can live in ./.ui-diff.json. Exit: 0 no visual change, 1 change found, 2 error.`);
  finish(2);
}
// UI_DIFF_TIMING=1 prints phase durations to stderr.
const t0 = Date.now();
const phase = (name) => process.env.UI_DIFF_TIMING && console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${name}`);

const DIR = path.resolve(process.env.UI_DIFF_DIR || '.ui-diff');
fs.mkdirSync(DIR, { recursive: true });
// Self-ignoring output folder: captures never end up in the project's git status.
if (!fs.existsSync(path.join(DIR, '.gitignore'))) fs.writeFileSync(path.join(DIR, '.gitignore'), '*\n');
const file = (s, ext = 'png') => path.join(DIR, `${opt.name}-${s}.${ext}`);
// One browser session per run, so parallel agents never share a page.
browser = makeBrowser(`ui-diff-${process.pid}`);
function captureNotes({ pinnedFixed, settled, hidden }) {
  if (hidden) console.log(`  hidden, not compared: ${hidden}`);
  if (pinnedFixed.length && mode === 'baseline') console.log(`  pinned fixed element(s) at their viewport position: ${pinnedFixed.join('; ')}`);
  if (!settled) console.log('  ⚠ page kept changing between shots; expect noise (animated or live content)');
}

if (mode === 'baseline') {
  const cap = await capture(browser, url, opt, file('before'), file('before', 'json'), phase);
  // Load the page a second time: what differs between two loads of the unchanged page
  // (streamed sections, reveal-on-scroll state) is volatile too, not only what flickers
  // within one load. Merged into the baseline manifest.
  await capture(browser, url, opt, file('before2'), file('before2', 'json'), phase);
  const m1 = JSON.parse(fs.readFileSync(file('before', 'json'), 'utf8')), m2 = JSON.parse(fs.readFileSync(file('before2', 'json'), 'utf8'));
  const cells = (await changedCells(file('before'), file('before2'))) ?? [];
  m1.volatileCells = [...new Set([...m1.volatileCells, ...m2.volatileCells, ...cells])];
  m1.volatileProps = [...new Set([...m1.volatileProps, ...m2.volatileProps, ...styleChanges(m1.elements, m2.elements)])];
  fs.writeFileSync(file('before', 'json'), JSON.stringify(m1));
  for (const f of [file('before2'), file('before2', 'json')]) fs.rmSync(f, { force: true });
  phase(`baseline volatility: ${m1.volatileCells.length} cells, ${m1.volatileProps.length} props`);
  const m = await sharp(file('before')).metadata();
  console.log(`✓ baseline saved (${m.width}x${m.height}): ${file('before')}`);
  captureNotes(cap);
  finish(0);
}

if (!fs.existsSync(file('before')) || !fs.existsSync(file('before', 'json'))) {
  console.error(`✗ no baseline for "${opt.name}"; run baseline first`);
  finish(2);
}
const readManifest = (s) => JSON.parse(fs.readFileSync(file(s, 'json'), 'utf8'));
if (!opt.reuse) captureNotes(await capture(browser, url, opt, file('after'), file('after', 'json'), phase));

const [mb, ma] = await Promise.all([sharp(file('before')).metadata(), sharp(file('after')).metadata()]);
const W = Math.max(mb.width, ma.width);
const [B, A] = await Promise.all([load(sharp, file('before'), W), load(sharp, file('after'), W)]);
const px = diffPixels(B, A); phase('pixels');
const mfB = readManifest('before'), mfA = readManifest('after');
const dom = diffDom(mfB.elements, mfA.elements, new Set([...(mfB.volatileProps ?? []), ...(mfA.volatileProps ?? [])]));
explain(px.regions, dom, B, A, new Set([...(mfB.volatileCells ?? []), ...(mfA.volatileCells ?? [])])); phase('explain');
// DOM changes that touch no changed pixels (e.g. an auto margin whose computed value flips
// while a streamed section settles) are noise for the reader: count them, don't list them.
const allGroups = groupCauses(dom.causes);
const groups = allGroups.filter((g) => g.some((c) => touchesAny(c, px.regions)));
const invisible = allGroups.length - groups.length;
const fullCost = imgTokens(mb.width, mb.height) + imgTokens(ma.width, ma.height);
const jitterNote = px.stats.jitter ? ` ${px.stats.jitter} px differ by <=2/255 (ignored as rendering jitter).` : '';

const domLines = () => {
  groups.slice(0, 10).forEach((g, i) => console.log(`    ${i + 1}. ${describeCause(g)}`));
  if (groups.length > 10) console.log(`    ... ${groups.length - 10} more`);
  if (invisible) console.log(`    (${invisible} more DOM change(s) with no visible pixel change, not listed)`);
  for (const e of dom.added.slice(0, 5)) console.log(`    added: ${e.l} at y=${e.y} ${e.w}x${e.h}`);
  for (const e of dom.removed.slice(0, 5)) console.log(`    removed: ${e.l} (was y=${e.y} ${e.w}x${e.h})`);
};

if (!px.regions.length && !px.moves.size) {
  console.log(`✓ no visual change (${W}x${B.H}).${jitterNote} No image needed. [saved ~${fullCost} image tokens]`);
  if (allGroups.length || dom.added.length || dom.removed.length) console.log(`  (${allGroups.length + dom.added.length + dom.removed.length} DOM change(s) without visible pixels)`);
  finish(0);
}

const count = (why) => px.regions.filter((g) => g.why === why).length;
// Volatile regions changed between identical shots of the same page: noise. A page whose
// only differences are volatile, with no DOM change and no move, has not visibly changed.
if (px.regions.length && px.regions.every((g) => g.why === 'volatile') && !groups.length && !dom.added.length && !dom.removed.length && !px.moves.size) {
  console.log(`✓ no visual change (${W}x${B.H}).${jitterNote} ${px.regions.length} region(s) differ only where the page also flickers between identical shots (volatile): ${px.regions.map((g) => g.label).join('; ')}. [saved ~${fullCost} image tokens]`);
  finish(0);
}
const sizeNote = mb.height !== ma.height || mb.width !== ma.width ? `; page ${mb.width}x${mb.height} -> ${ma.width}x${ma.height}` : '';
console.log(`✗ visual change: ${groups.length} DOM change(s), ${count('unexplained')} unexplained region(s)${sizeNote}.${jitterNote}`);
if (groups.length || dom.added.length || dom.removed.length) { console.log('  DOM changes:'); domLines(); }
const layoutLines = describeLayout(dom);
for (const [dy, m] of px.moves) layoutLines.push(`pixel rows ${m.b0}-${m.b1 - 1} moved ${dy > 0 ? '+' : ''}${dy}px, content identical`);
if (layoutLines.length) { console.log('  layout:'); layoutLines.forEach((l) => console.log(`    ${l}`)); }
console.log(`  pixel regions: ${px.regions.length} (${count('change')} by DOM changes, ${count('layout')} by layout only, ${count('volatile')} volatile, ${count('unexplained')} unexplained)${px.aligned ? '' : ' [row alignment over budget]'}`);
px.regions.filter((g) => g.why === 'unexplained').slice(0, 6).forEach((g, i) => {
  const r = g.a ?? g.b;
  const colour = g.colourShare >= 0.3 ? `  main colour ${g.colour} (${Math.round(g.colourShare * 100)}%)` : '';
  console.log(`    U${i + 1}. ${g.kind} y=${r.top} x=${r.left} ${r.width}x${r.height}  ${g.label}${colour}${g.subtle ? '  SUBTLE: trust the colour values over the image' : ''}`);
});

const tiles = planTiles({ regions: px.regions, groups, dom, B, A, showAll: opt.show === 'all' });
const { shown, skipped, scale } = fitTiles(tiles, Number(opt.budget));
if (!shown.length) {
  console.log(`  No image needed: every visible change is layout (moved/resized). Use --show all to see it. [saved ~${fullCost} image tokens]`);
  finish(1);
}
const out = file('review');
const L = await renderTiles(sharp, shown, scale, B, A, out); phase('render');
console.log(`  review image: ${out}`);
shown.forEach((t, i) => console.log(`    tile ${i + 1}: ${t.title}${t.b ? '' : ' (after only)'}${t.a ? '' : ' (before only)'}`));
if (scale < 1) console.log(`    scaled to ${Math.round(scale * 100)}% to fit the budget`);
if (skipped.length) console.log(`    not shown (over --budget ${opt.budget}): ${skipped.map((t) => t.title).join('; ')}`);
console.log(`  ${L.w}x${L.h} ≈ ${L.tokens} image tokens (two full screenshots ≈ ${fullCost})`);
finish(1);
