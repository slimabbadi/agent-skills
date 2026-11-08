#!/usr/bin/env node
// Self-test: runs ui-diff against a local test page edited nine ways and checks each verdict,
// report text and image-token cost. Cross-platform (Windows, macOS, Linux).
//
//   node scripts/selftest/selftest.mjs        exit 0 = all scenarios passed
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'ui-diff.mjs');
const original = fs.readFileSync(path.join(here, 'page.html'), 'utf8');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-diff-selftest-'));
const page = path.join(work, 'page.html');
const url = pathToFileURL(page).href;
const env = { ...process.env, UI_DIFF_DIR: path.join(work, 'shots') };

const BTN = ['/*AFTER*/', '#target .btn{background:#059669;padding:12px 26px;border-radius:999px}'];
const BANNER = ['<header>', '<div style="background:#fde68a;padding:14px 40px">Free first booking this week</div><header>'];

// [name, expected exit, replacements, extra args, { maxTokens, expect }]
const scenarios = [
  ['no-edit', 0, [], [], {}],
  ['small-edits', 1, [BTN, ['<h2>Tutoring</h2>', '<h2>Tutoring &amp; exam prep</h2>'], ['>Sign in<', '>Log in<']], [],
    { maxTokens: 300, expect: /background-color #1d4ed8 -> #059669/ }],
  ['layout-shift', 1, [BANNER], [], { maxTokens: 200, expect: /added: div "Free first booking/ }],
  ['element-scoped', 1, [BTN], ['--selector', '#target'], { expect: /border-radius/ }],
  // Design-token tweak: per-channel delta 7/4/7, invisible to loose pixel tolerances.
  ['subtle-colour', 1, [['background:#1d4ed8', 'background:#2452df']], [], { expect: /x3: background-color #1d4ed8 -> #2452df/ }],
  ['below-fold', 1, [['Contact support', 'Contact us']], [], { expect: /"Contact support" -> "Contact us"/ }],
  // A real edit inside content that also moved must still be reported.
  ['shift-plus-edit', 1, [BANNER, ['Contact support', 'Contact us']], [], { maxTokens: 200, expect: /"Contact support" -> "Contact us"/ }],
  // Backdrop that stretches when padding grows: pixels change everywhere, the DOM explains it.
  ['backdrop-stretch', 1, [['.hero{padding:60px 40px;', '.hero{padding:72px 40px;']], [], { maxTokens: 400, expect: /padding 60px 40px -> 72px 40px/ }],
  // Pixels change with no DOM change at all (canvas redrawn): must be unexplained and shown.
  ['canvas-no-dom', 1, [['fillStyle="#ef4444"', 'fillStyle="#3b82f6"']], [], { expect: /U1\. .*canvas#cv/ }],
];

const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 180_000 });
let failures = 0;
for (const [name, want, edits, extra, { maxTokens, expect }] of scenarios) {
  fs.writeFileSync(page, original);
  const base = run(['baseline', url, '--name', name, ...extra]);
  if (base.status !== 0) { failures++; console.log(`FAIL ${name}: baseline exited ${base.status}\n${base.stderr || base.stdout}`); continue; }
  let edited = original;
  for (const [from, to] of edits) {
    if (!edited.includes(from)) throw new Error(`scenario ${name}: anchor not found: ${from}`);
    edited = edited.split(from).join(to);
  }
  fs.writeFileSync(page, edited);
  const r = run(['check', url, '--name', name, ...extra]);
  const out = `${r.stdout}${r.stderr}`;
  const tokens = Number(out.match(/≈ (\d+) image tokens/)?.[1] ?? 0);
  const why = [];
  if (r.status !== want) why.push(`exit ${r.status}, expected ${want}`);
  if (!out.match(want === 0 ? /^✓ no visual change/m : /^✗ /m)) why.push('verdict line missing');
  if (maxTokens && tokens > maxTokens) why.push(`${tokens} image tokens > ${maxTokens}`);
  if (expect && !expect.test(out)) why.push(`missing ${expect}`);
  if (why.length) { failures++; console.log(`FAIL ${name}: ${why.join('; ')}\n${out}`); }
  else console.log(`PASS ${name}${tokens ? ` (${tokens} image tokens)` : ''}`);
}
fs.rmSync(work, { recursive: true, force: true });
console.log(failures ? `${failures} scenario(s) failed` : `all ${scenarios.length} scenarios passed`);
process.exit(failures ? 1 : 0);
