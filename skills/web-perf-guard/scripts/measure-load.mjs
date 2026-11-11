// Load-timeline and idle-cost probe for any web app, driven through system Chrome over CDP.
//
// Usage (run from a project that has playwright-core or @playwright/test installed):
//   node measure-load.mjs <url> [options]
//
// Options:
//   --runs N            cold runs, median reported (default 3)
//   --net P             none | fast4g (9 Mbps, 150 ms RTT) | slow4g (1.6 Mbps, 300 ms RTT)   (default none)
//   --cpu N             CPU throttling factor, 4 approximates a mid-range phone (default 1)
//   --vw W --vh H       viewport in CSS px (default 390x844)
//   --dpr N             deviceScaleFactor (default 2)
//   --block a,b         abort requests whose URL contains any of these hosts/substrings
//   --data REGEX        URLs counted as streamed data (default \.(bin|hrc|las|laz|pnts|glb|b3dm|pbf|mvt|ktx2)(\?|$))
//   --mark name=EXPR    milestone: first time the page JS expression is truthy (repeatable),
//                       e.g. --mark "ui=!!document.querySelector('[role=status]')"
//   --quiet MS          fully loaded = no request in flight for MS after the load event (default 2000)
//   --idle MS           after load, sample draw calls and frames with no input for MS (default 3000, 0 = skip)
//   --warm              also do a reload in the same context and count revalidations (304s)
//   --headed            show the browser
//
// Output: JSON on stdout. Times are ms from navigation start. Medians across cold runs.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const req = createRequire(pathToFileURL(process.cwd() + '/').href)
let chromium
try { ({ chromium } = req('playwright-core')) } catch {
  try { ({ chromium } = req('@playwright/test')) } catch {
    console.error('playwright-core not found from the current directory. Run from a project that has it, or: npm i -D playwright-core')
    process.exit(2)
  }
}

const a = process.argv.slice(2)
const url = a[0]
if (!url || url.startsWith('--')) { console.error('usage: node measure-load.mjs <url> [options]'); process.exit(2) }
const opt = (k, d) => { const i = a.indexOf('--' + k); return i < 0 ? d : a[i + 1] }
const runs = +opt('runs', 3), net = opt('net', 'none'), cpu = +opt('cpu', 1)
const vw = +opt('vw', 390), vh = +opt('vh', 844), dpr = +opt('dpr', 2)
const block = (opt('block', '') || '').split(',').filter(Boolean)
const dataRe = new RegExp(opt('data', String.raw`\.(bin|hrc|las|laz|pnts|glb|b3dm|pbf|mvt|ktx2)(\?|$)`))
const quiet = +opt('quiet', 2000), idleMs = +opt('idle', 3000)
const marks = a.flatMap((v, i) => (v === '--mark' ? [a[i + 1]] : [])).map((m) => {
  const j = m.indexOf('=')
  return [m.slice(0, j), m.slice(j + 1)]
})
const NETS = { fast4g: { latency: 150, down: 9e6 }, slow4g: { latency: 300, down: 1.6e6 } }

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((p, q) => p - q)
  return v.length ? v[Math.floor(v.length / 2)] : null
}

// Runs in the page before any app code.
const initScript = (markList) => {
  const T = (window.__perf = { lt: [], marks: {}, draws: 0 })
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => T.lt.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (e.name === 'first-contentful-paint') T.fcp = e.startTime })).observe({ type: 'paint', buffered: true })
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { T.lcp = e.startTime })).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {}
  // Count WebGL draw calls so idle rendering is visible.
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue
    for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const orig = C.prototype[fn]
      if (orig) C.prototype[fn] = function (...args) { T.draws++; return orig.apply(this, args) }
    }
  }
  const fns = markList.map(([name, expr]) => [name, new Function(`return (${expr})`)])
  const tick = () => {
    for (const [name, f] of fns) {
      if (T.marks[name] != null) continue
      try { if (f()) T.marks[name] = performance.now() } catch {}
    }
    if (fns.some(([n]) => T.marks[n] == null)) setTimeout(tick, 50)
  }
  if (fns.length) tick()
}

async function loadOnce(browser, ctx) {
  const page = await ctx.newPage()
  for (const h of block) await page.route((u) => u.href.includes(h), (r) => r.abort())
  await page.addInitScript(initScript, marks)
  const cdp = await ctx.newCDPSession(page)
  const reqs = new Map()
  let navTs = null, lastActivity = Date.now()
  const inflight = new Set()
  cdp.on('Network.requestWillBeSent', (e) => {
    if (!/^https?:/.test(e.request.url)) return // blob:, data: never report loadingFinished reliably
    if (navTs == null && e.type === 'Document') navTs = e.timestamp
    reqs.set(e.requestId, { id: e.requestId, url: e.request.url, type: e.type, t0: e.timestamp, seen: Date.now() })
    inflight.add(e.requestId); lastActivity = Date.now()
  })
  // responseReceived reports a revalidated 304 as 200; the ExtraInfo event carries the wire status.
  const wireStatus = new Map()
  cdp.on('Network.responseReceivedExtraInfo', (e) => wireStatus.set(e.requestId, e.statusCode))
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId)
    if (r) Object.assign(r, { status: e.response.status, headers: e.response.headers, proto: e.response.protocol, fromCache: e.response.fromDiskCache || e.response.fromMemoryCache })
  })
  const finish = (e, failed) => {
    const r = reqs.get(e.requestId)
    if (r) Object.assign(r, { bytes: e.encodedDataLength ?? 0, t1: e.timestamp, failed })
    inflight.delete(e.requestId); lastActivity = Date.now()
  }
  cdp.on('Network.loadingFinished', (e) => finish(e, false))
  cdp.on('Network.loadingFailed', (e) => finish(e, true))
  await cdp.send('Network.enable')
  if (NETS[net]) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: NETS[net].latency, downloadThroughput: NETS[net].down / 8, uploadThroughput: NETS[net].down / 8 / 3 })
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })

  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'load', timeout: 120000 })
  let timedOut = false
  // Requests with no response for 30 s (long-poll, sockets, lost events) do not hold "fully loaded" open.
  const stuck = () => [...inflight].filter((id) => Date.now() - reqs.get(id).seen > 30000)
  while (!(inflight.size - stuck().length === 0 && Date.now() - lastActivity >= quiet)) {
    if (Date.now() - t0 > 120000) { timedOut = true; break }
    await page.waitForTimeout(100)
  }
  if (inflight.size) console.error(`note: ${inflight.size} request(s) never finished, e.g. ${reqs.get([...inflight][0]).url}`)
  const ms = (ts) => (ts == null || navTs == null ? null : Math.round((ts - navTs) * 1000))
  const all = [...reqs.values()]
  const done = all.filter((r) => r.t1 != null)
  const fullyLoaded = timedOut ? null : ms(Math.max(...done.map((r) => r.t1)))

  const P = await page.evaluate(() => {
    const T = window.__perf, nav = performance.getEntriesByType('navigation')[0]
    const c = [...document.querySelectorAll('canvas')].sort((x, y) => y.width * y.height - x.width * x.height)[0]
    let canvas = null
    if (c) {
      const r = c.getBoundingClientRect()
      let gl = null
      try { gl = c.getContext('webgl2') || c.getContext('webgl') } catch {}
      const at = gl?.getContextAttributes?.()
      canvas = { css: [Math.round(r.width), Math.round(r.height)], backing: [c.width, c.height], devicePixelRatio, antialias: at?.antialias ?? null, powerPreference: at?.powerPreference ?? null }
    }
    return { fcp: T.fcp, lcp: T.lcp, lt: T.lt, marks: T.marks, ttfb: nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, canvas }
  })

  let idle = null
  if (idleMs > 0 && !timedOut) {
    idle = await page.evaluate((dur) => new Promise((resolve) => {
      const d0 = window.__perf.draws, times = []
      const t0 = performance.now()
      const tick = (t) => {
        times.push(t)
        if (t - t0 < dur) requestAnimationFrame(tick)
        else {
          const secs = (performance.now() - t0) / 1000
          const gaps = times.slice(1).map((x, i) => x - times[i]).sort((p, q) => p - q)
          resolve({ drawsPerSec: Math.round((window.__perf.draws - d0) / secs), rafPerSec: Math.round(times.length / secs), p95FrameMs: gaps.length ? +gaps[Math.floor(gaps.length * 0.95)].toFixed(1) : null })
        }
      }
      requestAnimationFrame(tick)
    }), idleMs)
  }

  const data = all.filter((r) => dataRe.test(r.url))
  let maxParData = 0
  for (const r of data) maxParData = Math.max(maxParData, data.filter((q) => q.t1 != null && r.t1 != null && q.t0 < r.t1 && q.t1 > r.t0).length)
  const tbt = Math.round(P.lt.filter(([s]) => fullyLoaded == null || s <= fullyLoaded).reduce((s, [, d]) => s + Math.max(0, d - 50), 0))
  const kind = (r) => (dataRe.test(r.url) ? 'data' : r.type)
  const headers = {}
  for (const r of all) {
    const k = kind(r)
    if (headers[k] || !r.headers) continue
    const h = Object.fromEntries(Object.entries(r.headers).map(([x, y]) => [x.toLowerCase(), y]))
    headers[k] = { example: r.url.split('?')[0].split('/').pop(), encoding: h['content-encoding'] ?? 'none', cacheControl: h['cache-control'] ?? '-', etag: !!h.etag, protocol: r.proto }
  }
  const chain = all.filter((r) => !dataRe.test(r.url)).sort((p, q) => p.t0 - q.t0).slice(0, 15)
    .map((r) => ({ url: r.url.length > 90 ? '…' + r.url.slice(-89) : r.url, type: r.type, start: ms(r.t0), end: ms(r.t1), bytes: r.bytes }))
  const firstData = data.length ? Math.min(...data.map((r) => ms(r.t0))) : null

  await page.close()
  return {
    ttfb: Math.round(P.ttfb), fcp: P.fcp && Math.round(P.fcp), lcp: P.lcp && Math.round(P.lcp), dcl: Math.round(P.dcl), load: Math.round(P.load),
    ...Object.fromEntries(marks.map(([n]) => ['mark:' + n, P.marks[n] == null ? null : Math.round(P.marks[n])])),
    firstDataRequest: firstData, fullyLoaded, requests: all.length, bytes: all.reduce((s, r) => s + (r.bytes || 0), 0),
    dataRequests: data.length, dataBytes: data.reduce((s, r) => s + (r.bytes || 0), 0), maxParallelData: maxParData,
    longTasks: P.lt.length, tbt, idleDrawsPerSec: idle?.drawsPerSec ?? null, idleRafPerSec: idle?.rafPerSec ?? null,
    _canvas: P.canvas, _headers: headers, _chain: chain,
    _status: all.reduce((m, r) => {
      const k = r.fromCache ? 'cache' : wireStatus.get(r.id) ?? r.status ?? 'failed'
      m[k] = (m[k] || 0) + 1
      return m
    }, {}),
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: !a.includes('--headed'), args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })
const newCtx = () => browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, isMobile: vw < 900, hasTouch: vw < 900 })
const cold = []
for (let i = 0; i < runs; i++) { const ctx = await newCtx(); cold.push(await loadOnce(browser, ctx)); await ctx.close() }
let warm = null
if (a.includes('--warm')) {
  const ctx = await newCtx()
  await loadOnce(browser, ctx)
  const w = await loadOnce(browser, ctx)
  warm = { fcp: w.fcp, fullyLoaded: w.fullyLoaded, requests: w.requests, bytes: w.bytes, statusCounts: w._status }
  await ctx.close()
}
await browser.close()

const keys = Object.keys(cold[0]).filter((k) => !k.startsWith('_'))
console.log(JSON.stringify({
  config: { url, runs, net, cpu, viewport: [vw, vh], dpr, block, quietMs: quiet },
  median: Object.fromEntries(keys.map((k) => [k, median(cold.map((r) => r[k]))])),
  perRun: cold.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]]))),
  canvas: cold[0]._canvas, headers: cold[0]._headers, statusCounts: cold[0]._status, firstRequests: cold[0]._chain, warm,
}, null, 1))
