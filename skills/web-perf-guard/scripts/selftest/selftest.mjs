// Self-test for web-perf-guard's scripts. No browser needed: checks big-strings.cjs on a
// synthetic bundle and that measure-load.mjs parses and fails cleanly on bad input.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' })

const dir = mkdtempSync(join(tmpdir(), 'wpg-'))
const bundle = join(dir, 'bundle.js')
const worker = 'self.onmessage=function(e){postMessage(e.data)};' + 'x'.repeat(4000)
const shader = 'precision highp float;void main(){gl_FragColor=vec4(1.0);}' + ' '.repeat(3500)
writeFileSync(bundle, [
  `const w=${JSON.stringify(worker)};`,
  `const s=\`${shader}\${1}tail\`;`,
  `const re=/"[^"]{5000}/g;`, // a regex containing a quote must not derail the tokenizer
  `const small="short";`,
].join('\n'))

const out = run(join(scripts, 'big-strings.cjs'), bundle, '3000')
assert.equal(out.status, 0, out.stderr)
assert.match(out.stdout, /worker/, 'finds the inlined worker')
assert.match(out.stdout, /glsl/, 'finds the shader template literal')
assert.match(out.stdout, /total \d+ chars in 2 strings/, 'ignores the small string and the regex')

assert.equal(run('--check', join(scripts, 'measure-load.mjs')).status, 0, 'measure-load.mjs parses')
const bad = run(join(scripts, 'measure-load.mjs'))
assert.equal(bad.status, 2, 'missing URL exits 2')
console.log('web-perf-guard selftest: ok')
