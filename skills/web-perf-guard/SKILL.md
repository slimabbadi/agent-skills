---
name: web-perf-guard
description: Loading-time and runtime-cost guard for web frontends, strongest on WebGL / three.js / react-three-fiber and streamed 3D or map data (point clouds, tiles). Use when auditing load time, bundle size, caching, idle CPU or battery, or frame cost; when asked why a page loads or runs slowly; and when building or changing a canvas/viewer, a heavy dependency, a data loader, the build config, or a perf test harness, so the defaults are right from the start.
---

# Web perf guard

Two branches share one rule catalogue, [`rules.md`](rules.md). Read it in full on either branch.

- **Build**: you are writing or changing frontend code. Apply the rules' **Default** lines as you write, so each gap never appears. Before finishing, run the rules whose **Detect** fits the change (e.g. a new dependency → J1, J3; a new canvas → R1, P1, L1).
- **Audit**: you are asked to find what is slow or costly. Follow the steps below.

## Audit steps

1. **Inventory.** Stack, build tool, entry point, heavy dependencies, data sources and their format, deploy target (or "unknown"), existing perf tests and what server they run against. Done when each item has a value or "none".
2. **Build for production** and record every chunk's raw and gzip size plus every build warning, verbatim.
3. **Baseline, measured.** Serve the production build (never the dev server) and run [`scripts/measure-load.mjs`](scripts/measure-load.mjs) from the project directory:
   - unthrottled and `--net fast4g --cpu 4`, 3 cold runs each, phone viewport;
   - `--mark` one expression per app milestone (UI visible, first real content); the script adds FCP/LCP, fully loaded (network quiet), long tasks, data requests, idle draw calls, canvas backing size, response headers;
   - `--warm` once; `--dpr 1` once when the page has a canvas.
   On a connected Android phone, repeat the load timings there too (recipe under M2). Done when every milestone has a median number.
4. **Walk every rule** in `rules.md` against code and numbers. Each rule gets exactly one verdict: **finding**, **fine**, **n/a**, or **unmeasured** (with the reason).
5. **Verify each finding before reporting it.** Open the library source behind any claim about library behaviour (setters, workers, LOD, format support) and quote the line. A claim from a subagent or from memory counts as a hypothesis until you have read the code or measured it. Rejections are results: report them.
6. **Report**, ranked by user-facing impact: finding, evidence (number or `file:line`), cost, fix, and status (measured / code-verified / hypothesis). Then one line per rule verdicted fine or n/a, so coverage is visible.

Completion: every rule in `rules.md` carries a verdict, and every finding carries a number or a `file:line`.

## Evidence discipline

- A finding without a number is a hypothesis. Rank by measured cost, not by how familiar the pattern is: a textbook render-blocking chain can cost nothing in practice, and a harmless-looking default can triple the download.
- Change one variable per comparison (block one host, change one DPR, one throttle profile) and keep everything else fixed.
- Medians of 3+ cold runs; the first run of a batch is usually an outlier.
