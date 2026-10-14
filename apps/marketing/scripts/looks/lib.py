from art import art

# ---------- contrast ----------
def _lin(c):
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
def _rgb(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(ch * 2 for ch in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
def lum(h):
    r, g, b = _rgb(h)
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)
def cr(a, b):
    la, lb = lum(a), lum(b)
    if la < lb: la, lb = lb, la
    return (la + 0.05) / (lb + 0.05)
def _hex(t): return '#%02x%02x%02x' % tuple(max(0, min(255, round(x))) for x in t)

ADJ = []   # report of auto-adjusted text colours
CHECKS = []
def fix(fg, bg, need=4.5, label=''):
    """Darken/lighten fg until it reaches `need` against bg (used for coloured TEXT only)."""
    if cr(fg, bg) >= need:
        CHECKS.append((label, fg, bg, cr(fg, bg))); return fg
    target = (0, 0, 0) if lum(bg) > 0.4 else (255, 255, 255)
    base = _rgb(fg)
    for i in range(1, 101):
        t = i / 100
        c = _hex(tuple(base[k] + (target[k] - base[k]) * t for k in range(3)))
        if cr(c, bg) >= need:
            ADJ.append((label, fg, c, bg)); CHECKS.append((label, c, bg, cr(c, bg))); return c
    return fg
def on(bg, ink='#10151C', light='#ffffff', label=''):
    c = light if cr(light, bg) >= cr(ink, bg) else ink
    CHECKS.append((label or 'on ' + bg, c, bg, cr(c, bg)))
    return c
def chk(label, fg, bg, need=4.5):
    CHECKS.append((label, fg, bg, cr(fg, bg)))
    return fg

# ---------- icons ----------
def I(n, s=22):
    p = {
        'search': '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
        'bag': '<path d="M6 8h12l-1 12H7z"/><path d="M9 8V7a3 3 0 016 0v1"/>',
        'menu': '<path d="M4 7h16M4 12h16M4 17h16"/>',
        'plus': '<path d="M12 5v14M5 12h14"/>',
        'minus': '<path d="M5 12h14"/>',
        'heart': '<path d="M12 20s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.5-7 10-7 10z"/>',
        'check': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
        'pin': '<path d="M12 21s6-5.6 6-10.5a6 6 0 10-12 0C6 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/>',
    }[n]
    return (f'<svg viewBox="0 0 24 24" width="{s}" height="{s}" fill="none" stroke="currentColor" stroke-width="1.8" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{p}</svg>')

def fmt(n): return f'{n:,} ج.م'
def price(n, old=None, cls=''):
    o = f' <s class="old">{fmt(old)}</s>' if old else ''
    return f'<span class="price {cls}">{fmt(n)}</span>{o}'

import os, base64
CUR = [None]
_PH = {}
HERE = os.path.dirname(os.path.abspath(__file__))
# Source photos (jpg, ~720px) are NOT committed (img-src/ is git-ignored); point LOOKS_IMG_DIR at the folder
# gen.py writes to. The committed result is public/looks/img/*.webp.
IMGDIR = os.environ.get('LOOKS_IMG_DIR') or os.path.join(HERE, 'img-src')
WEBDIR = os.path.join(HERE, '..', '..', 'public', 'looks', 'img')
EXPORT = [False]   # export mode (export.py): photos are <img> files under /looks/img, never base64
USED = {}
EXPORTED = {}      # webp name -> source jpg path (or None when the webp already exists)
STATS = {'photo': 0, 'svg': 0}
def photo(key):
    p = os.path.join(IMGDIR, f'{CUR[0]}__{key}.jpg')
    if EXPORT[0]:
        name = f'{CUR[0]}__{key}.webp'
        if os.path.exists(p): EXPORTED[name] = p
        elif os.path.exists(os.path.join(WEBDIR, name)): EXPORTED.setdefault(name, None)
        else: return None
        return f'/looks/img/{name}'
    if p not in _PH:
        _PH[p] = ('data:image/jpeg;base64,' + base64.b64encode(open(p, 'rb').read()).decode()) if os.path.exists(p) else None
    return _PH[p]

def img(kind, cw, alt='', scale=1.0, extra='', pk=None):
    u = photo(pk or kind)
    if u:
        STATS['photo'] += 1
        if EXPORT[0]:
            return f'<img class="im" src="{u}" alt="{alt}" loading="lazy" decoding="async">'
        cl = f'{CUR[0]}-{pk or kind}'; USED[cl] = u
        return f'<div class="im i-{cl}" role="img" aria-label="{alt}"></div>'
    STATS['svg'] += 1
    b1, b2, c, d, a = cw
    return f'<img src="{art(kind, b1, b2, c, d, a, scale, extra)}" alt="{alt}" loading="lazy">'

# ---------- shared css for every phone (scoped by & -> #id) ----------
BASE = """
& {width:100%;height:100%;overflow-y:auto;overflow-x:hidden;background:var(--bg);color:var(--ink);font-family:var(--fb),Tajawal,system-ui,sans-serif;font-size:14px;line-height:1.6;scrollbar-width:thin;-webkit-overflow-scrolling:touch}
& *{box-sizing:border-box}
& img{display:block;width:100%;height:100%;object-fit:cover}
& h1,& h2,& h3,& p{margin:0}
& h2,& h3,& .disp{font-family:var(--fd),var(--fb),serif;font-weight:700;line-height:1.35}
& a{color:inherit;text-decoration:none}
& button{font:inherit;cursor:pointer;color:inherit}
& .ph{overflow:hidden;position:relative}
& .im{width:100%;height:100%;background-size:cover;background-position:center;background-repeat:no-repeat}
& .ib{width:44px;height:44px;border:0;background:none;display:grid;place-items:center;padding:0;color:inherit}
& .price{font-weight:700;font-size:14px;white-space:nowrap}
& .old{text-decoration:line-through;color:var(--mut);font-weight:400;font-size:12px;margin-inline-start:4px;white-space:nowrap}
& .row{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding:0 16px}
& .row::-webkit-scrollbar{display:none}
& .nm{font-size:13px;font-weight:500;line-height:1.45}
& .sm{font-size:12px;color:var(--mut)}
& .fl{font-family:var(--fl),var(--fb),serif}
& ul{list-style:none;margin:0;padding:0}
"""

def footer(bg, fg, mut, brand, line, links, pay='الدفع عند الاستلام · إنستاباي · فيزا / ماستركارد'):
    chk('footer link', fg, bg); chk('footer muted', mut, bg)
    ls = ''.join(f'<li><a href="#">{l}</a></li>' for l in links)
    return (f'<footer class="ft" style="background:{bg};color:{fg};padding:28px 20px 40px">'
            f'<div class="disp" style="font-size:28px;line-height:1.2">{brand}</div>'
            f'<p style="color:{mut};font-size:13px;margin:6px 0 16px">{line}</p>'
            f'<ul style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-size:13px">{ls}</ul>'
            f'<p style="color:{mut};font-size:12px;margin-top:18px;border-top:1px solid {mut}55;padding-top:12px">{pay}</p></footer>')
