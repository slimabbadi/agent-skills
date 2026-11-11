// Text-first check of a specimen page. Run:  agent-browser eval "$(cat "SKILL_DIR/verify.js")"   (SKILL_DIR: this skill's folder)
// Reports horizontal overflow, font loading, touch targets under 44px, and WCAG contrast of every visible text element
// against its real background (worst stop of a gradient). Text over an image is listed as "manual".
(async () => {
  await document.fonts.ready;
  const d = document.documentElement;
  const parse = s => { const m = s.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+%?))?\)/); if (!m) return null;
    let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4]; return [+m[1], +m[2], +m[3], a]; };
  const lum = ([r, g, b]) => { const f = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  const over = (top, bot) => [0, 1, 2].map(i => top[i] * top[3] + bot[i] * (1 - top[3]));
  const hex = c => "#" + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, "0")).join("");

  // Backgrounds under an element: a list of candidate colours (several for a gradient), or null when an image is in the way.
  function backgrounds(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none") {
        if (/url\(/.test(cs.backgroundImage)) return null;
        const stops = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(m => parse(m[0])).filter(Boolean);
        // >= 90% opacity counts as solid: the bleed barely moves contrast, and compositing it over every stop below overstates it
        if (stops.length) { const solid = stops.every(s => s[3] >= .9); layers.push(solid ? stops.map(s => [s[0], s[1], s[2], 1]) : stops); if (solid) break; }
      }
      const bg = parse(cs.backgroundColor);
      if (bg && bg[3] > 0) { if (bg[3] >= .9) { layers.push([[bg[0], bg[1], bg[2], 1]]); break; } layers.push([bg]); }
    }
    let cands = [[255, 255, 255, 1]];
    for (const layer of layers.reverse()) cands = layer.flatMap(t => cands.map(b => [...over(t, b), 1]));
    cands.gradient = layers.some(l => l.length > 1);
    return cands;
  }

  const textEls = [...document.querySelectorAll("body *")].filter(el =>
    [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length &&
    getComputedStyle(el).visibility !== "hidden" && !el.closest("svg,[aria-hidden=true],script,style"));
  const fails = [], manual = [];
  for (const el of textEls) {
    const cs = getComputedStyle(el), fg = parse(cs.color); if (!fg) { manual.push(el.tagName); continue; }
    const bgs = backgrounds(el); const label = (el.className ? "." + String(el.className).split(" ")[0] : el.tagName.toLowerCase()) + ' "' + el.textContent.trim().slice(0, 28) + '"';
    if (!bgs) { manual.push(label); continue; }
    const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    const need = el.matches(":disabled, :disabled *, [aria-disabled=true] *") ? 0 : large ? 3 : 4.5;
    const rs = bgs.map(b => ratio(over(fg, b), b)), worst = Math.min(...rs), best = Math.max(...rs);
    // A gradient whose stops spread contrast widely can't be scored from the DOM: the text sits on one part of it.
    if (bgs.gradient && best / worst > 1.5 && best >= need) { if (worst < need) manual.push(`${label} ${hex(fg)} ${worst.toFixed(2)} to ${best.toFixed(2)}:1 over a gradient, need ${need}`); continue; }
    if (worst < need) fails.push(`${label} ${hex(fg)} ${worst.toFixed(2)}:1 < ${need}`);
  }

  const targets = [...document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab], [role=switch]")]
    .filter(el => el.getClientRects().length && el.type !== "hidden")
    .map(el => [el, el.getBoundingClientRect()]).filter(([, r]) => r.width < 43.5 || r.height < 43.5)
    .map(([el, r]) => `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} "${(el.getAttribute("aria-label") || el.textContent).trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);

  const scrollers = el => { for (let n = el.parentElement; n; n = n.parentElement) if (/(auto|scroll|hidden)/.test(getComputedStyle(n).overflowX)) return true; return false; };
  const overflow = [...document.querySelectorAll("body *")].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > d.clientWidth + 1 && !scrollers(el); })
    .slice(0, 10).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} right=${Math.round(el.getBoundingClientRect().right)}`);

  const families = [...new Set(textEls.map(el => getComputedStyle(el).fontFamily.split(",")[0].trim().replace(/["']/g, "")))];
  const fonts = families.map(f => `${f}: ${/^(ui-|system-ui|monospace|serif|sans-serif)/.test(f) ? "system" : [...document.fonts].some(x => x.family.replace(/["']/g, "") === f && x.status === "loaded") ? "loaded" : "NOT LOADED"}`);

  return JSON.stringify({
    viewport: `${d.clientWidth}x${innerHeight}`, horizontalScroll: d.scrollWidth > d.clientWidth, overflow,
    fonts, smallTargets: targets.slice(0, 20), smallTargetCount: targets.length,
    contrastFails: fails.slice(0, 30), contrastFailCount: fails.length, textChecked: textEls.length, manualCheck: manual.slice(0, 20), manualCount: manual.length,
  }, null, 1);
})()
