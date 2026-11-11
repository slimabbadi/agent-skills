"""Design-kit tooling: measure a reference image, check contrast, render token sections, check a kit.

  python kit.py palette IMAGE [--colors 16] [--crop x0,y0,x1,y1]   dominant colours with share, plus a contrast matrix
  python kit.py peak IMAGE --crop x0,y0,x1,y1 [--by sat|lum] [--n 40]   true colour of small accents and text (avoids anti-alias blending)
  python kit.py contrast FG BG [FG BG ...]                         WCAG ratio per pair
  python kit.py tokens TOKENS.css SPECIMEN.html                    (re)write the token sections between <!-- tokens:start --> and <!-- tokens:end -->
  python kit.py check TOKENS.css KIT.css SPECIMEN.html             exit 1 on undefined variables or a stale token block; warns on unused tokens
"""
import argparse
import colorsys
import html
import re
import sys
from pathlib import Path

START, END = "<!-- tokens:start -->", "<!-- tokens:end -->"


# ---------- colour maths ----------
def _hex(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def luminance(rgb):
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (v / 255 for v in rgb)]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def ratio(a, b):
    la, lb = sorted((luminance(_hex(a)), luminance(_hex(b))), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def grade(r):
    return "AAA" if r >= 7 else "AA" if r >= 4.5 else "AA-large" if r >= 3 else "fail"


def _open(path, crop):
    from PIL import Image
    img = Image.open(path).convert("RGB")
    full = img.size
    if crop:
        img = img.crop(tuple(int(v) for v in crop.split(",")))
    return img, full


def cmd_palette(a):
    from PIL import Image
    img, full = _open(a.image, a.crop)
    img.thumbnail((400, 400))
    q = img.quantize(colors=a.colors, method=Image.Quantize.MEDIANCUT)
    pal, total = q.getpalette(), img.width * img.height
    rows = [("#%02x%02x%02x" % tuple(pal[i * 3:i * 3 + 3]), n / total) for n, i in sorted(q.getcolors(), reverse=True)]
    print(f"{a.image}  full {full[0]}x{full[1]}  crop={a.crop or 'none'}\n\nhex       share")
    for h, s in rows:
        print(f"{h}  {s:6.1%}")
    top = [h for h, s in rows if s >= 0.005][:10]
    print("\ncontrast (row text on column background)\n         " + " ".join(f"{h:>8}" for h in top))
    for fg in top:
        print(f"{fg}  " + " ".join(f"{ratio(fg, bg):8.2f}" for bg in top))


def cmd_peak(a):
    img, _ = _open(a.image, a.crop)
    px = list(img.getdata())
    if a.by == "sat":
        key = lambda c: (lambda h, s, v: s * v * v)(*colorsys.rgb_to_hsv(*(x / 255 for x in c)))
    else:
        key = sum
    px.sort(key=key, reverse=True)
    top = px[:a.n]
    avg = tuple(sum(c[i] for c in top) // len(top) for i in range(3))
    print("#%02x%02x%02x  (mean of the %d most %s pixels in %s)" % (*avg, len(top), "saturated" if a.by == "sat" else "luminous", a.crop))


def cmd_contrast(a):
    if len(a.pairs) % 2:
        sys.exit("contrast takes FG BG pairs")
    for fg, bg in zip(a.pairs[::2], a.pairs[1::2]):
        r = ratio(fg, bg)
        print(f"{fg} on {bg}: {r:.2f}:1  {grade(r)}")


# ---------- tokens ----------
DECL = re.compile(r"(--[\w-]+)\s*:\s*([^;{}]+?)\s*;")


def parse_tokens(css):
    """Ordered {name: (value, comment)}; the first definition wins (later ones are responsive overrides)."""
    css = re.sub(r"@import[^;]+;", "", css)
    out = {}
    for line in css.splitlines():
        decls = list(DECL.finditer(line))
        if not decls:
            continue
        m = re.search(r"/\*(.*?)\*/", line[decls[-1].end():])
        comment = m.group(1).strip() if m else ""
        for i, d in enumerate(decls):
            name, value = d.group(1), d.group(2).strip()
            if name in out:
                out[name] = (out[name][0], out[name][1], True)
            else:
                out[name] = (value, comment if i == len(decls) - 1 else "", False)
    return out


def resolve(name, toks, depth=0):
    v = toks[name][0]
    m = re.fullmatch(r"var\((--[\w-]+)\)", v)
    if m and m.group(1) in toks and depth < 10:
        return resolve(m.group(1), toks, depth + 1)
    return v


COLOR = re.compile(r"^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|(linear|radial|conic)-gradient\()", re.I)
LENGTH = re.compile(r"^(-?[\d.]+(px|rem|em)|clamp\(|min\(|max\(|calc\()", re.I)


def kind(name, value):
    if COLOR.match(value) or value.lower() in ("transparent", "black", "white"):
        return "color"
    if "shadow" in name:
        return "shadow"
    if "font" in name and "fs" not in name and "weight" not in name:
        return "family"
    if re.search(r"(^|-)(fs|size-text|text-size)(-|$)", name[2:]):
        return "size"
    if LENGTH.match(value):
        return "length"
    return "other"


def render_tokens(toks):
    e = html.escape
    groups = {k: [] for k in ("color", "family", "size", "length", "shadow", "other")}
    for n in toks:
        groups[kind(n, resolve(n, toks))].append(n)

    def note(n):
        v, c, resp = toks[n]
        bits = [e(v)] + ([e(c)] if c else []) + (["responsive"] if resp else [])
        return " · ".join(bits)

    o = [START, "<!-- Generated by kit.py tokens from the token file. Edit the token file, then rerun; hand edits here are overwritten. -->",
         "<style>.tk-sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:12px}"
         ".tk-sw div{border:1px solid var(--sp-line);border-radius:12px;overflow:hidden;background:var(--sp-panel)}"
         ".tk-sw i{display:block;height:56px}.tk-sw b{display:block;padding:10px 12px 0;font-size:13px;font-weight:500;overflow-wrap:anywhere}"
         ".tk-sw span,.tk-row span{display:block;padding:2px 12px 12px;font-size:11.5px;color:var(--sp-text-3);overflow-wrap:anywhere}"
         ".tk-rows{border:1px solid var(--sp-line);border-radius:12px;overflow:hidden;margin-top:12px}"
         ".tk-row{display:grid;grid-template-columns:minmax(0,240px) minmax(0,1fr);gap:16px;align-items:center;padding:14px 16px;border-top:1px solid var(--sp-line)}"
         ".tk-row:first-child{border-top:0}.tk-row b{font-size:12.5px;font-weight:500;overflow-wrap:anywhere}.tk-row span{padding:2px 0 0}"
         ".tk-row .demo{min-width:0;overflow:hidden}.tk-bar{display:block;height:10px;background:var(--sp-text);border-radius:2px;max-width:100%}"
         ".tk-box{display:block;width:140px;height:64px;border-radius:12px;background:var(--sp-panel)}"
         "@media (max-width:640px){.tk-row{grid-template-columns:1fr}}</style>"]

    def row(n, demo):
        return f'<div class="tk-row"><div><b>{n}</b><span>{note(n)}</span></div><div class="demo">{demo}</div></div>'

    if groups["color"]:
        o.append('<h2 id="colour">Colour</h2><div class="tk-sw">')
        o += [f'<div><i style="background:var({n})"></i><b>{n}</b><span>{note(n)}</span></div>' for n in groups["color"]]
        o.append("</div>")
    type_ = groups["family"] + groups["size"]
    if type_:
        o.append('<h2 id="type">Type</h2><div class="tk-rows">')
        o += [row(n, f'<span style="padding:0;font-family:var({n});font-size:20px;color:var(--sp-text)">Survey 0123456789</span>') for n in groups["family"]]
        o += [row(n, f'<span style="padding:0;font-size:var({n});line-height:1.1;color:var(--sp-text)">Sample 128</span>') for n in groups["size"]]
        o.append("</div>")
    if groups["length"] or groups["shadow"]:
        o.append('<h2 id="space">Space, shape, depth</h2><div class="tk-rows">')
        o += [row(n, f'<i class="tk-bar" style="width:var({n})"></i>') for n in groups["length"]]
        o += [row(n, f'<i class="tk-box" style="box-shadow:var({n})"></i>') for n in groups["shadow"]]
        o.append("</div>")
    if groups["other"]:
        o.append('<h2 id="other">Weights, motion, other</h2><div class="tk-rows">')
        o += [row(n, "") for n in groups["other"]]
        o.append("</div>")
    o.append(END)
    return "\n".join(o)


def _block(text):
    i, j = text.find(START), text.find(END)
    return (i, j + len(END)) if i != -1 and j != -1 else None


def cmd_tokens(a):
    toks = parse_tokens(Path(a.tokens).read_text(encoding="utf-8"))
    spec = Path(a.specimen)
    text = spec.read_text(encoding="utf-8")
    span = _block(text)
    if not span:
        sys.exit(f"{spec}: no {START} … {END} markers")
    spec.write_text(text[:span[0]] + render_tokens(toks) + text[span[1]:], encoding="utf-8")
    print(f"{spec}: rendered {len(toks)} tokens")


def cmd_check(a):
    tok_css = Path(a.tokens).read_text(encoding="utf-8")
    kit_css = Path(a.kit).read_text(encoding="utf-8")
    spec = Path(a.specimen).read_text(encoding="utf-8")
    toks = parse_tokens(tok_css)
    span = _block(spec)
    fail = False
    if not span:
        print(f"FAIL  no token block markers in {a.specimen}")
        fail, spec_rest = True, spec
    else:
        if spec[span[0]:span[1]] != render_tokens(toks):
            print("FAIL  token block is stale: run  kit.py tokens", a.tokens, a.specimen)
            fail = True
        spec_rest = spec[:span[0]] + spec[span[1]:]
    # Local custom properties (component knobs like --p, inline style="--h:.6", JS setProperty) count as defined.
    defined = set(toks) | set(re.findall(r"(--[\w-]+)\s*:", kit_css + spec_rest))
    defined |= set(re.findall(r"setProperty\(\s*['\"](--[\w-]+)", spec_rest))
    used_src = tok_css + kit_css + spec_rest
    used = set(re.findall(r"var\(\s*(--[\w-]+)", used_src))
    with_fallback = set(re.findall(r"var\(\s*(--[\w-]+)\s*,", used_src))  # var(--h, .5): a knob with a default
    undefined = sorted(used - defined - with_fallback)
    for n in undefined:
        print(f"FAIL  var({n}) is used but never defined")
    fail |= bool(undefined)
    unused = [n for n in toks if len(re.findall(re.escape(n) + r"(?![\w-])", used_src)) <= 1]
    for n in unused:
        print(f"warn  {n} is defined but no role, component or specimen uses it")
    print(f"{'FAIL' if fail else 'PASS'}  {len(toks)} tokens, {len(used)} referenced, {len(undefined)} undefined, {len(unused)} unused")
    sys.exit(1 if fail else 0)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("palette"); s.add_argument("image"); s.add_argument("--colors", type=int, default=16); s.add_argument("--crop"); s.set_defaults(f=cmd_palette)
    s = sub.add_parser("peak"); s.add_argument("image"); s.add_argument("--crop", required=True); s.add_argument("--by", choices=("sat", "lum"), default="sat"); s.add_argument("--n", type=int, default=40); s.set_defaults(f=cmd_peak)
    s = sub.add_parser("contrast"); s.add_argument("pairs", nargs="+"); s.set_defaults(f=cmd_contrast)
    s = sub.add_parser("tokens"); s.add_argument("tokens"); s.add_argument("specimen"); s.set_defaults(f=cmd_tokens)
    s = sub.add_parser("check"); s.add_argument("tokens"); s.add_argument("kit"); s.add_argument("specimen"); s.set_defaults(f=cmd_check)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
