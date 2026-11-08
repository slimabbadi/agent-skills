---
name: ui-diff
description: Before/after check of a web UI change at minimal image-token cost. It returns a text report of what changed (styles, text, layout, unexplained pixels) and at most one small cropped image. Use when verifying a frontend edit, checking for visual regressions, or comparing screenshots of a page before and after a change.
---

# ui-diff

Capture a page **before** you edit it, capture it again **after**, and read what changed. The comparison runs locally: pixels are aligned like a text diff, and each changed region is matched to the DOM change that caused it. The model only pays for an image when something visible changed. Even then, the image holds just the changed elements, cropped, within a token budget (400 by default; two full-page screenshots typically cost 2,000–5,000).

`scripts/` sits next to this file. Below, `$UI_DIFF` stands for `node <this skill's directory>/scripts/ui-diff.mjs`.

## Setup (once per machine)

1. Put `agent-browser` on PATH (`npm i -g agent-browser`, then `agent-browser install` for Chromium; on Linux `agent-browser install --with-deps`).
2. Install the image library: `npm install --prefix <this skill's directory>/scripts`.
3. Optional proof that the machine is ready: `node <this skill's directory>/scripts/selftest/selftest.mjs`. It exits 0 when all scenarios pass.

## Steps

1. **Baseline before the first edit:** `$UI_DIFF baseline <url> --name <slug>`. Use one slug per page or state, such as `home` or `checkout-mobile`. A baseline loads the page twice to learn which parts flicker on their own.
2. **Make the change.**
3. **Check:** `$UI_DIFF check <url> --name <slug>`. Exit 0 means no visual change, 1 means a change was found, and 2 means an error.
4. **Read the text report first**, then decide on the image:
   - Every listed DOM change is one you intended and the report shows `0 unexplained`: the text is the evidence, so leave the image unopened.
   - The report lists unexplained regions (`U1.`…), or you need to judge how something looks: open the review image path the report prints. Open it once, at the end of the work, because an image read mid-task is re-billed on every later turn.
5. **Iterate** by re-running `check` against the same baseline. Take a new baseline only when you accept the current state as the new reference.

The step is done when the report lists exactly the changes you intended, and every unexplained region is either understood or fixed.

## Reading the report

- **DOM changes** are the causes: element label, then `property before -> after` (colours as hex) or `text "old" -> "new"`. Identical changes are grouped (`x3`). Changes that touch no changed pixels are only counted.
- **layout** lists the consequences: elements moved by (dx,dy), resized elements, and pixel rows that shifted with identical content. These are expected effects of a size or spacing change, so they get no image.
- **pixel regions** puts every changed area into one of four classes:
  - *by DOM changes* and *by layout only* are explained.
  - *volatile* means the page also changed there between two identical captures.
  - *unexplained* means pixels changed and nothing in the DOM accounts for it, for example canvas, images, or pseudo-elements. Unexplained regions are always in the image: they are where regressions hide.
- **SUBTLE** marks a change too faint to see, such as a design-token tweak. Trust the hex values in the text over the image.
- **Spacing changes** (margin, padding, gap) show in a crop only relative to neighbours. The text gives the exact values.

## Noise and options

- `⚠ page kept changing between shots` means live content (animations, carousels, timers). Hide it with `--hide "<css selectors>"`, or scope the check with `--selector <css>` to the element you changed.
- Consent banners and chat widgets belong in `--hide`. Hidden elements are always listed in the report.
- Project defaults go in `.ui-diff.json` in the working directory, for example `{ "hide": "#cookie-banner", "width": 1440 }`. Flags override it.
- `position:fixed` elements are pinned where they sit on the page, so they stay in the comparison.
- Captures go to `.ui-diff/` in the working directory. That folder ignores itself in git.
- Run `$UI_DIFF` with no arguments to print all flags.
