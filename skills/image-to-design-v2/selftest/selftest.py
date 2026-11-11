"""Self-test for kit.py. Needs Python 3.9+ and Pillow (for palette and peak). Exit 0 means every check passed."""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent / "kit.py"
TEMPLATE = KIT.parent / "specimen-template.html"
failures = []


def run(*args):
    p = subprocess.run([sys.executable, str(KIT), *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    return p.returncode, p.stdout + p.stderr


def expect(name, cond, out=""):
    print(f"{'ok  ' if cond else 'FAIL'}  {name}")
    if not cond:
        failures.append(name)
        print(out)


TOKENS = """:root {
  --x-ink: #111111;
  --x-paper: #fafafa;
  --x-bg: var(--x-paper);              /* page ground */
  --x-surface-solid: #ffffff;           /* cards */
  --x-line: #dddddd;
  --x-text: var(--x-ink);               /* body text · 18.1:1 on bg */
  --x-text-2: #444444;
  --x-text-3: #666666;
  --x-font-text: "Inter", system-ui, sans-serif;
  --x-font-display: var(--x-font-text);
  --x-fs-body: 14px;
  --x-radius: 8px;
  --x-orphan: 4px;
  --x-shadow-1: 0 1px 2px rgba(0,0,0,.1);
}
"""
KIT_CSS = ".card { background: var(--x-surface-solid); border-radius: var(--x-radius); box-shadow: var(--x-shadow-1); font-size: var(--x-fs-body); }\n"

with tempfile.TemporaryDirectory() as d:
    d = Path(d)

    code, out = run("contrast", "#000", "#fff", "#777777", "#ffffff")
    expect("contrast: black on white is 21:1 AAA", code == 0 and "21.00:1  AAA" in out, out)
    expect("contrast: #777 on white is 4.48:1 AA-large", "4.48:1  AA-large" in out, out)
    code, out = run("contrast", "#000")
    expect("contrast: odd argument count is rejected", code != 0, out)

    try:
        from PIL import Image
        img = Image.new("RGB", (200, 100), "#202020")
        img.paste((230, 40, 40), (150, 40, 170, 60))  # a small saturated accent
        img.save(d / "ref.png")
        code, out = run("palette", d / "ref.png", "--colors", "4")
        expect("palette: prints size and dominant ground", code == 0 and "full 200x100" in out and "#202020" in out, out)
        code, out = run("peak", d / "ref.png", "--crop", "140,30,180,70", "--by", "sat")
        expect("peak: recovers the accent colour", code == 0 and out.startswith("#e62828"), out)
    except ImportError:
        expect("Pillow is installed (needed for palette and peak)", False)

    tok, kit, spec = d / "tokens.css", d / "kit.css", d / "specimen.html"
    tok.write_text(TOKENS, encoding="utf-8")
    kit.write_text(KIT_CSS, encoding="utf-8")
    shutil.copy(TEMPLATE, spec)

    code, out = run("check", tok, kit, spec)
    expect("check: fails while the token block is stale", code == 1 and "stale" in out, out)

    code, out = run("tokens", tok, spec)
    html = spec.read_text(encoding="utf-8")
    expect("tokens: renders every token", code == 0 and "rendered 14 tokens" in out, out)
    expect("tokens: groups colour, type and space", all(h in html for h in ('id="colour"', 'id="type"', 'id="space"')), out)
    expect("tokens: carries the role comment", "page ground" in html and "18.1:1 on bg" in html, out)

    code, out = run("check", tok, kit, spec)
    expect("check: passes on a fresh kit", code == 0 and "PASS" in out and "undefined" in out, out)
    expect("check: warns on a token nothing uses", "warn  --x-orphan is defined but" in out and "1 unused" in out, out)

    kit.write_text(KIT_CSS + ".bad { color: var(--x-missing); }\n.ok { opacity: var(--knob, .5); }\n", encoding="utf-8")
    code, out = run("check", tok, kit, spec)
    expect("check: fails on an undefined variable", code == 1 and "var(--x-missing) is used but never defined" in out, out)
    expect("check: accepts a var() with a fallback", "--knob" not in out, out)

    tok.write_text(TOKENS.replace("#444444", "#454545"), encoding="utf-8")
    kit.write_text(KIT_CSS, encoding="utf-8")
    code, out = run("check", tok, kit, spec)
    expect("check: a token edit makes the block stale again", code == 1 and "stale" in out, out)

print(f"\n{'FAIL' if failures else 'PASS'}  {len(failures)} failed")
sys.exit(1 if failures else 0)
