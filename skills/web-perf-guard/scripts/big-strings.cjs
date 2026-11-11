// Lists string literals of at least N chars in a JS file (minified bundles included):
// inlined workers, wasm, shaders, embedded data. Heuristic tokenizer, no dependencies.
// Usage: node big-strings.cjs <file.js> [minChars=3000]
// Each line: length, tags (worker / wasm / brotli / glsl), first 60 chars. Template literals are
// measured per static segment (text between ${...}).
const fs = require('fs')
const [file, minArg] = process.argv.slice(2)
if (!file) { console.error('usage: node big-strings.cjs <file.js> [minChars]'); process.exit(2) }
const min = Number(minArg || 3000)
const s = fs.readFileSync(file, 'utf8')
const hits = []
const keep = (from, to) => { if (to - from >= min) hits.push(s.slice(from, to)) }

// '/' starts a regex when the previous significant token cannot end an expression.
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))
const KEYWORDS_BEFORE_REGEX = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/
let i = 0, prev = ''
const braceStack = [] // inside ${...}: brace depth to know when the template resumes
let depth = 0

function scanTemplate() { // s[i] is just past a backtick or a closing } of ${...}
  let start = i
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === '`') { keep(start, i); i++; prev = '`'; return }
    if (c === '$' && s[i + 1] === '{') { keep(start, i); i += 2; braceStack.push(depth); depth++; prev = '{'; return }
    i++
  }
}

while (i < s.length) {
  const c = s[i]
  if (c === '"' || c === "'") {
    const q = c, start = ++i
    while (i < s.length && s[i] !== q && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1
    keep(start, i); i++; prev = q; continue
  }
  if (c === '`') { i++; scanTemplate(); continue }
  if (c === '/' && s[i + 1] === '/') { const n = s.indexOf('\n', i); i = n < 0 ? s.length : n; continue }
  if (c === '/' && s[i + 1] === '*') { const n = s.indexOf('*/', i + 2); i = n < 0 ? s.length : n + 2; continue }
  if (c === '/' && (prev === '' || REGEX_AFTER.has(prev) || KEYWORDS_BEFORE_REGEX.test(s.slice(Math.max(0, i - 12), i).trimEnd()))) {
    i++; let inClass = false
    while (i < s.length && s[i] !== '\n') {
      if (s[i] === '\\') { i += 2; continue }
      if (s[i] === '[') inClass = true
      else if (s[i] === ']') inClass = false
      else if (s[i] === '/' && !inClass) break
      i++
    }
    i++; while (/[a-z]/i.test(s[i] || '')) i++
    prev = ')'; continue
  }
  if (c === '{') { depth++; prev = c; i++; continue }
  if (c === '}') {
    depth--
    if (braceStack.length && braceStack[braceStack.length - 1] === depth) { braceStack.pop(); i++; scanTemplate(); continue }
    prev = c; i++; continue
  }
  if (!/\s/.test(c)) prev = c
  i++
}

hits.sort((x, y) => y.length - x.length)
for (const t of hits) {
  const tags = [
    /onmessage|postMessage/.test(t) && 'worker',
    /AGFzbQ|\\0asm/.test(t) && 'wasm',
    /brotli/i.test(t) && 'brotli',
    /gl_Position|gl_FragColor|gl_PointSize|precision (high|medium)p/.test(t) && 'glsl',
  ].filter(Boolean).join(',')
  console.log(t.length, tags || '-', JSON.stringify(t.slice(0, 60)))
}
console.log(`total ${hits.reduce((n, t) => n + t.length, 0)} chars in ${hits.length} strings >= ${min}`)
