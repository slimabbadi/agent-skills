# Rule catalogue

Each rule: **Why** (the cost, with magnitudes seen in real audits), **Detect** (how to find it in any project), **Default** (what to write from the start). **Verify** marks rules that are easy to flag wrongly.

## M. Measurement

### M1. Measure the production build
- **Why:** a dev server ships unbundled, uncompressed modules and runs React StrictMode double effects. Seen: dev 14 MB vs prod 1.8 MB; first paint 11.9 s vs 1.0 s on throttled 4G; a phone harness that passed every check while blind to load regressions.
- **Detect:** in e2e/perf configs (`playwright.config.*` `webServer.command`, device scripts, CI), the served command is `dev` / `vite` / `next dev` / `webpack serve`.
- **Default:** functional e2e may use dev; anything that measures time, bytes or frames serves `build` + `preview` (or the real host).

### M2. Measure where users are
- **Why:** localhost and USB-tethered phones have no real round-trip time. Seen: identical bytes took 0.4 s unthrottled and 3.8 s at 150 ms RTT; a cable-attached phone showed the best case only.
- **Detect:** perf numbers exist only unthrottled, or only on desktop.
- **Default:** report unthrottled and `fast4g + 4x CPU`; when an Android phone is on ADB, also run there: `adb reverse tcp:PORT tcp:PORT`, open Chrome at the URL, `adb forward tcp:0 localabstract:chrome_devtools_remote`, then Playwright `chromium.connectOverCDP`; clear cache with CDP `Network.clearBrowserCache`, and apply `Network.emulateNetworkConditions` there too since the cable hides RTT. Idle CPU: sum `adb shell top -b -n 4 -d 2` %CPU of the chrome, privileged/sandboxed and surfaceflinger processes (iterations 2-4) with the app idle vs `about:blank`.

### M3. Gate loading milestones, not only FPS
- **Why:** FPS on a capped display (60/90/120 Hz) hides GPU and power cost, and it says nothing about load.
- **Detect:** the perf harness asserts only fps / frame time.
- **Default:** name milestones (UI visible, first real content, fully loaded, idle draw calls/s) and assert on them alongside frame time.

### M4. Budgets in CI
- **Why:** guidance gets skipped; a failing check does not. The industry standard is an enforced budget (size-limit / bundlesize, Lighthouse CI, a custom milestone assertion).
- **Detect:** no size or timing assertion in `verify`/CI scripts.
- **Default:** entry-chunk gzip budget + milestone budget in the verify script.

## J. JavaScript delivery

### J1. The entry chunk carries only the first paint
- **Why:** everything statically imported from the entry downloads, parses and runs before anything paints. Seen: 1.43 MB single chunk where ~70% was 3D-only; ~240 ms parse+eval at 4x CPU before any network time.
- **Detect:** build output shows one JS chunk, or entry > ~250 kB min / ~80 kB gzip; static import path from the entry (`main.*`) to heavy libs (`three`, `@react-three/*`, map/point-cloud/chart engines, editors).
- **Default:** heavy view libraries behind `React.lazy(() => import(...))` / `import()` with a light shell (HUD, header, skeleton) painting first. Byte attribution: `npx source-map-explorer dist/assets/*.js` (build with `--sourcemap`) or `npx vite-bundle-visualizer`.

### J2. Build warnings are findings
- **Why:** Vite/Rollup's "Some chunks are larger than 500 kB" is the J1 alarm; an ignored warning means nobody looked.
- **Detect:** read the build log; grep it for `larger than`, `(!)`, `warning`.
- **Default:** fix the cause, or set `chunkSizeWarningLimit` with a comment justifying the number.

### J3. Pre-bundled libraries ship everything
- **Why:** a dependency published as one minified file (no ESM, no `sideEffects: false`) is not tree-shaken, and often embeds workers, wasm and shaders as strings, plus loaders for formats you do not use. Seen: ~160 kB of inlined worker code for a data format the app never loaded.
- **Detect:** `package.json` of the dep (`main` points to one `dist/index.js`, no `module`/`exports` ESM split); `node scripts/big-strings.cjs <bundle or dep file>` lists large literals tagged worker/wasm/glsl; grep the dep for the format markers it supports and compare with the data you serve.
- **Default:** pick the data format the library's shipped code is optimised for, lazy-load the library (J1), or choose a modular alternative.

### J4. Compression
- **Why:** brotli beats gzip by ~15-25% on JS (seen: 317 kB vs 412 kB). Dev/preview servers often gzip only text types.
- **Detect:** `Content-Encoding` on real GET requests with `Accept-Encoding: br, gzip` (HEAD responses can differ); `measure-load.mjs` prints per-type headers.
- **Default:** host serves brotli for JS/CSS/HTML/JSON; precompress at build (`.br`) when the host cannot.

## C. Critical path

### C1. Start known data fetches before the framework
- **Why:** when the first data URL is static, waiting for the bundle to download and evaluate serialises the two. Seen: first data request at 1.16 s, after bundle eval, on throttled 4G.
- **Detect:** in the waterfall, the first data request starts after the main JS finishes; its URL is a constant in source.
- **Default:** `<link rel="preload" as="fetch" crossorigin href="...">` in the HTML (match credentials mode), or fire the fetch at module top level of a tiny entry and hand the promise to the app.

### C2. Paint something without JS
- **Why:** an empty `<div id="root">` means a blank screen for the whole bundle download + eval.
- **Detect:** built `index.html` body has no visible content; FCP ≈ bundle eval end.
- **Default:** static shell (background, title, skeleton) in `index.html`, or SSR/SSG.

### C3. Third-party render-blocking CSS
- **Why:** `@import url(https://...)` in CSS (typical: Google Fonts) chains CSS → third-party CSS → font files across new origins. The stylesheet stays pending until the import resolves, and a pending stylesheet blocks first paint *and* the execution of deferred/module scripts, so the app mounts late too. The cost is whatever part of the third-party chain the bundle download does not already hide, so it varies by run and network. Seen on one app: 60-400 ms of first paint and app mount on a fast connection, ~0 on throttled 4G where the bundle took longer. **Verify:** measure with the host blocked (`--block fonts.googleapis.com,fonts.gstatic.com`), unthrottled and throttled, 3+ runs each, and report the spread.
- **Detect:** grep `@import url\(['"]?https?:` in source CSS and in the first bytes of built CSS.
- **Default:** self-host fonts (woff2, `font-display: swap`, preload the one used above the fold) or `<link>` + `preconnect` in the HTML.

### C4. Main-thread work during load
- **Why:** long tasks delay input and paint. **Verify:** before flagging decode cost, check whether the library already decodes in workers (`blob:` script requests, `new Worker`, worker pools in source). Seen: decoding was already in pooled workers; the only long tasks were bundle evaluation.
- **Detect:** `PerformanceObserver` `longtask` (the script reports count and TBT); a trace (`devtools.timeline`, `v8.compile`) names the culprit.
- **Default:** parse/decode binary data in workers with transferable buffers.

## N. Network, caching, streamed data

### N1. Cache headers match content addressing
- **Why:** `Cache-Control: no-cache` on everything turns every reload into one revalidation round trip per file. Seen: 51 × 304 on a warm reload; warm load only ~20% faster than cold on 4G.
- **Detect:** `measure-load.mjs --warm` (requests vs bytes on the reload); headers per type; absence of host config (`_headers`, `vercel.json`, `netlify.toml`, `staticwebapp.config.json`, nginx/CDN rules).
- **Default:** hashed `/assets/*` → `public, max-age=31536000, immutable`; HTML → `no-cache`; unhashed data in `public/` → versioned paths (`/data/v3/...`) with long max-age, or ETag + a short max-age. Write the host requirement down even before the host is chosen.

### N2. Streamed data is round-trip bound
- **Why:** per-node/per-tile files fetched level by level with low concurrency scale with RTT, not bandwidth. Seen: 41 node files, 3 concurrent, 0.4 s → 3.8 s from unthrottled to 150 ms RTT.
- **Detect:** data request count and `maxParallelData` from the script; compare `fullyLoaded` unthrottled vs throttled (big gap, same bytes = latency-bound); the library's concurrency setting (grep `maxNumNodesLoading`, `maxRequests`, `concurrency`).
- **Default:** container formats with HTTP Range requests and built-in compression (point clouds: Potree 2 `octree.bin`/`hierarchy.bin` over Potree 1.x per-node files; maps: PMTiles; 3D: 3D Tiles with compressed glb); HTTP/2+ host; raise loader concurrency to what the host serves well.

### N3. Ship only the attributes you render
- **Why:** per-point/per-vertex attributes no shader reads (normals, intensity, classification in an RGB-only viewer) are paid for in bytes and decode time. **Verify:** confirm the loader actually downloads and decodes them; formats that store attributes interleaved make them unavoidable without reconversion.
- **Detect:** dataset metadata attribute list vs the color/shading modes the UI offers.
- **Default:** convert with only the needed attributes, or choose a format with per-attribute ranges.

### N4. Host fits big static data
- **Why:** multi-MB data needs Range support, compression, HTTP/2+ and a CDN; a host chosen without this check caps every rule above.
- **Default:** state the host requirements in the README or deploy docs.

## R. Render loop (WebGL, three.js, react-three-fiber)

### R1. Zero draws when nothing changes
- **Why:** continuous rendering burns battery and heat on phones while the user only looks. Seen: ~9,000 draw calls/s with no input; Chrome + compositor at ~175% of one core vs ~4% for a blank page.
- **Detect:** `idleDrawsPerSec` from the script (> 0 after load with no input = continuous); `<Canvas>` without `frameloop="demand"`; `useFrame` / `setAnimationLoop` / rAF loops doing per-frame work (`controls.update()`, LOD/visibility updates such as `updatePointClouds`) unconditionally.
- **Default:** render on demand: `frameloop="demand"` and `invalidate()` on controls `change`, damping still moving, data arrival, setting changes; streaming LOD updates on camera change and node-load events. Keep continuous rendering only while something animates or loads.

### R2. Frame-loop data stays out of React state at the root
- **Why:** calling a root `setState` from the frame loop re-renders the whole tree (including the `<Canvas>` subtree) on every tick.
- **Detect:** `useFrame`/rAF callbacks calling a setter passed from the component that renders `<Canvas>`.
- **Default:** write stats into a ref/store read only by the HUD component (or update text nodes directly); keep `<Canvas>` props stable (hoist object literals such as `camera={{...}}`).

### R3. Per-frame property assignment
- **Verify:** before flagging "sets material/uniform props every frame", read the setter. Many libraries guard with `if (value !== current)`, which makes repeated assignment a cheap no-op (seen in a point-cloud material whose decorators compared before recompiling).
- **Detect:** assignments in `useFrame`/render loops; then the setter source in the library.
- **Default:** assign on change (in an effect keyed on the value) when the setter is unguarded.

### R4. No allocation in the frame loop
- **Detect:** `new Vector3|Matrix4|Quaternion|Color|Box3` or array/object literals inside `useFrame` / rAF callbacks.
- **Default:** module-level or `useMemo` scratch objects reused per frame.

## P. Pixels

### P1. Choose pixel ratio and antialiasing deliberately
- **Why:** default DPR on a 2.6x phone renders ~4x the CSS pixels; MSAA adds cost and does nothing for point sprites.
- **Detect:** `canvas.width / clientWidth` vs `devicePixelRatio`; `getContextAttributes().antialias` (the script prints both); `<Canvas>` / `WebGLRenderer` without explicit `dpr` / `setPixelRatio` and `antialias`.
- **Default:** explicit `dpr={[1, 1.5]}` (or adaptive, e.g. drei `PerformanceMonitor`), `antialias` decided per content type.

### P2. In LOD and streaming renderers, pixel ratio is a data knob
- **Why:** screen-space-error LOD (point clouds, 3D tiles, terrain) often multiplies by the drawing-buffer size, so a higher DPR downloads more data, not only fills more pixels. Seen: DPR 2 vs 1 at the same viewport loaded 3.3x the requests and bytes on a phone viewport and 4.1x (the whole dataset) on desktop.
- **Detect:** grep the library's visibility/LOD code for `getPixelRatio()` / `getDrawingBufferSize` / `devicePixelRatio`; run `measure-load.mjs` at `--dpr 1` and `--dpr 2` with the same viewport and compare `dataRequests`/`dataBytes`.
- **Default:** cap DPR for streaming views and tune the LOD/point budget per device class.

## L. Lifecycle

### L1. Dispose GPU resources
- **Why:** removing an object from the scene leaves its buffers, textures and workers alive; remounts and route changes leak.
- **Detect:** `scene.remove(` / unmount cleanups without a matching `.dispose()`; check the library's typings for `dispose` methods.
- **Default:** cleanup calls the library's `dispose()` (geometry, material, textures, loader/worker pools).

### L2. Async loads in effects abort and clean up
- **Why:** React StrictMode runs effects twice in development, and real unmounts happen mid-load; a `cancelled` flag that only drops the result leaves the loaded object and its requests alive.
- **Detect:** `useEffect` that starts a load and on cleanup sets a flag without aborting (`AbortController`) or disposing a late result.
- **Default:** abort in-flight requests; dispose a result that arrives after cleanup.

### L3. Lazy ref initialisation
- **Detect:** `useRef(new X())` (constructs on every render; only the first is kept).
- **Default:** `useState(() => new X())[0]` or a null-checked ref. Low cost unless the constructor is heavy or has side effects.

## H. Hygiene

### H1. No build artifacts in git
- **Detect:** `git ls-files` shows `*.tsbuildinfo`, `dist/`, `.vite/`, coverage or report folders.
- **Default:** ignore them in `.gitignore` from the first commit.
