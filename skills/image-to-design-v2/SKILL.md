---
name: image-to-design-v2
description: Turn a reference image (screenshot, mockup, moodboard) into the current project's design kit, with tokens, component CSS and a specimen page, using bundled measuring and checking tools. Usage /image-to-design-v2 <image-path> [notes]
disable-model-invocation: true
argument-hint: <image-path> [notes]
---

# Image to design kit (v2)

Arguments: `$ARGUMENTS`. The image is the path given, or the saved path of an attached image (`[Attached image … saved at: <path>]`); any other text is the user's notes (what to keep, what to drop, the screen it's for). Every value in the kit traces back to the image as **sampled** (measured from pixels), **inferred** (read from the image, not measurable, such as a font family) or **derived** (invented in the image's language because the project needs it and the image doesn't show it). This provenance is the backbone of the kit.

`SKILL_DIR` is the folder holding this `SKILL.md` (Claude Code prints it as "Base directory for this skill"; other agents, use the path you loaded this file from). Every bundled file lives there: `kit.py`, `verify.js`, `specimen-template.html`. `K` below means `python "SKILL_DIR/kit.py"`; run `K -h` for every subcommand.

The browser steps use the `agent-browser` CLI. Load the `agent-browser` skill when your agent lists it; otherwise run `agent-browser skills get core --full` once for its commands. When the `agent-browser` command isn't installed, run every other step, and mark steps 4.3 and 6.2 unverified in the report.

## 1. Read the inputs

- Open the image so you can see it (Claude Code: the Read tool). No image: ask for it and stop.
- Read the project's product context: `PRODUCT.md`, `DESIGN.md`, `AGENTS.md`/`CLAUDE.md`, `package.json`, any existing tokens, theme or `design-kit/` folder, and any script that builds previews of kits or mocks. The product's users, constraints and accessibility rules outrank the image.
- When a kit already exists, ask whether to replace it, extend it, or write a parallel kit under a new name (recommend parallel). Wait for the answer. To learn which components the product needs, read the existing kit's component file.
- Load the `frontend-design` skill before writing any CSS or HTML.

Done when you can name the stack, where design files belong, the token prefix, and the components the product needs.

## 2. Measure

- `K palette IMAGE --colors 16`, then again with `--crop x0,y0,x1,y1` on a module, a control and the ground. This gives surfaces and grounds.
- `K peak IMAGE --crop … --by sat` for each accent, and `--by lum` for each text tier. Quantising blends thin strokes and small text with what's around them; `peak` gives their true colour. Use a tight crop around one glyph run or one fill.
- From the image itself, inventory every distinct element: ground and surfaces, lines, text tiers, accents and what they signal, type (category, weight, case, tracking, numerals), radius, spacing rhythm, elevation, iconography, and each component with its states. Estimate sizes against the image's full dimensions (`palette` prints them).

Done when every element in the inventory has a value and a provenance tag.

## 3. Build tokens

Write primitives first, then semantic roles that components read (`--x-bg`, `--x-surface`, `--x-surface-solid`, `--x-line`, `--x-text`, `--x-text-2`, `--x-text-3`, `--x-accent`, `--x-accent-text` when the accent fails as small text, `--x-on-accent`, `--x-focus`, status colours the product needs), then type (`--x-font-*`, `--x-fs-*`, weights), spacing, radius, elevation (`--x-shadow-*`) and motion. Put each role's meaning and contrast ratio in a comment on the same line as the declaration; the specimen renders that comment.

- Fonts: name the closest freely available match and mark it a substitute, with a fallback stack.
- Contrast: check every text role against every surface it can sit on, including presentation-only grounds such as a hero backdrop. Fix failures by moving lightness and keeping the hue: `K contrast FG BG FG BG …`
- Respect the project's stated rules (touch target size, reduced motion, focus visibility).

Output in the project's idiom: CSS custom properties by default; with Tailwind, also map them into the theme config; with an existing theme object, extend it.

## 4. Tracer module

Before building the rest, prove the language on one piece:

1. In the component file, write only the module container, its label, its value, and the reference's most distinctive graphic.
2. Copy `SKILL_DIR/specimen-template.html` to the specimen location, fill its `FILL` slots for paths and the `--sp-*` mapping, and put that one module in the hero with real product data. Run `K tokens TOKENS SPECIMEN` to render the token sections.
3. Open the specimen with `agent-browser` at desktop width, take one viewport screenshot, and compare it with the reference: ground, lighting, accent, type weight and density, and the graphic's grain.

Done when the screenshot and the reference agree on those five points. Fix tokens now, while nothing is built on them.

## 5. Build components and the specimen

- **Component file**: every component the image shows plus every one the product needs, styled from semantic tokens only, with default, hover, active, focus-visible and disabled states.
- **Specimen**: fill the remaining `FILL` slots. Components: real usage in a module, then every state. Provenance: one row per inventory element, including what was dropped and why. Use it: import lines for the stack and markup for components with structure. Use the product's real vocabulary and plausible data.
- After any token change, rerun `K tokens TOKENS SPECIMEN`. The token sections are generated; never hand-edit between the markers.
- When the project has a preview build (found in step 1), register the specimen in it.

## 6. Verify

Load the `ui-verification` skill. Then:

1. `K check TOKENS KIT SPECIMEN` exits 0. It fails on undefined variables or a stale token block, and warns on tokens nothing uses (use them or delete them).
2. With the specimen open in `agent-browser`, at 375px and at 1280px: `agent-browser eval "$(cat "SKILL_DIR/verify.js")"`, and `agent-browser errors`. Fix every contrast failure, overflow, unloaded font and target under 44px; check `manualCheck` entries by hand.
3. Take a second screenshot only if a fix changed the look; compare it to the step 4 shot with `agent-browser diff screenshot --baseline <file>`, not by opening it.

Done when `check` passes and `verify.js` reports no failures at either width.

## 7. Report

Lead each line with a status marker. List the files written, the substitute fonts, every contrast fix (from → to, with ratios), the derived components, what was dropped from the image, and anything unverified (browsers not tested, components not wired into the app).
