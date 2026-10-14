"""Export the template looks for ebda.app (npm run looks -w apps/marketing).

Writes, under apps/marketing/public/looks/:
  <template>.html   fragment: <style> (scoped per phone) + one block per look, separated by <!--look-->
  img/<fn>__<key>.webp  photos (converted from LOOKS_IMG_DIR jpgs when present; existing webps are kept)
and apps/marketing/src/lib/looks-fonts.ts (Google Fonts families per template).
No base64 anywhere. Photos are lazy <img>, links and idle buttons are inert (tabindex -1) except the engine's controls
(data-cat, data-add, data-open-*), which the working-phone engine binds to.
"""
import os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib
lib.EXPORT[0] = True
from lib import BASE
from catalog import T, FONTS

ROOT = os.path.join(lib.HERE, '..', '..')
OUT = os.path.join(ROOT, 'public', 'looks')
os.makedirs(os.path.join(OUT, 'img'), exist_ok=True)
# Controls that stay in the tab order: the in-phone engine (src/lib/phone-store-dom.ts) binds to these.
INTERACTIVE = re.compile(r'class="(?:chip|cmp|day)\b|data-(?:add|open-cart|open-menu|open-search|bundle)\b')

def inert(html):
    html = re.sub(r'<a (href="#")(?![^>]*data-cat)', r'<a tabindex="-1" \1', html)
    def btn(m):
        tag = m.group(0)
        return tag if INTERACTIVE.search(tag) else tag.replace('<button ', '<button tabindex="-1" ', 1)
    return re.sub(r'<button [^>]*>', btn, html)

# Class names the marketing site's own CSS also defines: prefixed so the site cannot restyle a phone.
CLASH = ('btn', 'hero', 'lead', 'price')

def ns_css(css):
    return re.sub(r'\.(%s)(?![\w-])' % '|'.join(CLASH), r'.x-\1', css)

def ns_html(html):
    def cls(m):
        return 'class="' + ' '.join('x-' + c if c in CLASH else c for c in m.group(1).split()) + '"'
    return re.sub(r'class="([^"]*)"', cls, html)

def scrollers(css):
    """Classes whose rule makes them scroll horizontally."""
    return set(re.findall(r'\.([\w-]+)\s*\{[^}]*overflow-x:\s*(?:auto|scroll)', css))

def focusable_scrollers(html, classes):
    """A horizontal scroller with nothing focusable inside must itself be focusable (WCAG 2.1.1)."""
    def tag(m):
        t = m.group(0)
        cl = set(re.search(r'class="([^"]*)"', t).group(1).split())
        return t[:-1] + ' tabindex="0">' if cl & classes else t
    return re.sub(r'<(?:div|ul|nav|section)\b[^>]*class="[^"]*"[^>]*>', tag, html)

def dedupe_alt(html):
    """An image whose alt repeats the visible label right after it is decorative (axe image-redundant-alt)."""
    def alt(m):
        return m.group(0).replace('alt="%s"' % m.group(1), 'alt=""', 1) if re.search('>\\s*' + re.escape(m.group(1)) + '\\s*<', m.string[m.end():m.end() + 260]) else m.group(0)
    return re.sub(r'<img class="im"[^>]*? alt="([^"]+)"[^>]*>', alt, html)

def ps_css(scope):
    """The working-phone engine styles (phone-store.css), scoped like a look's own CSS but once per template."""
    css = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'phone-store.css'), encoding='utf-8').read()
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S).replace('&', scope)
    return re.sub(r'\s*\n\s*', ' ', css).strip()

def fam(font):
    return font.split(':')[0].replace('+', ' ')

fonts_by_tpl = {}
for tid, en, ar, vert, items in T:
    styles, blocks, used = [], [], set()
    for fn, letter, name, purpose, idea in items:
        lib.CUR[0] = fn.__name__
        css, html = fn()
        pid = f'ph-{tid}-{letter.lower()}'
        scoped = ns_css((BASE + css).replace('&', '#' + pid))
        html = dedupe_alt(ns_html(html))
        html = focusable_scrollers(html, scrollers(BASE + css) - {'scr'})
        used.update(re.findall(r"--f[dbl]:'([^']+)'", css))
        styles.append(re.sub(r'\s*\n\s*', ' ', scoped))
        blocks.append(f'<div class="scr" id="{pid}" dir="rtl" lang="ar" tabindex="0" role="region" aria-label="{ar} · {en} {letter} {name}">{inert(html)}</div>')
    styles.append(ps_css(':is(' + ','.join(f'#ph-{tid}-{x[1].lower()}' for x in items) + ')'))
    frag = '<style>' + ''.join(styles) + '</style><!--look-->' + '<!--look-->'.join(blocks)
    assert 'data:' not in frag and 'base64' not in frag, f'{tid}: inline data URI in fragment'
    with open(os.path.join(OUT, f'{tid}.html'), 'w', encoding='utf-8') as f: f.write(frag)
    fonts_by_tpl[tid] = [f for f in FONTS if fam(f) in used]
    missing = used - {fam(f) for f in FONTS}
    assert not missing, f'{tid}: fonts not in FONTS: {missing}'
    print(tid, 'fragment', len(frag.encode()), 'bytes; fonts', [fam(f) for f in fonts_by_tpl[tid]])

assert lib.STATS['svg'] == 0, f"{lib.STATS['svg']} looks use the SVG fallback instead of a photo"
n = 0
for name, src in sorted(lib.EXPORTED.items()):
    dst = os.path.join(OUT, 'img', name)
    if src is None: continue
    png = dst + '.tmp.png'
    subprocess.run(['sips', '-Z', '720', '-s', 'format', 'png', src, '--out', png], check=True, capture_output=True)
    subprocess.run(['cwebp', '-quiet', '-q', '72', '-m', '6', png, '-o', dst], check=True)
    os.remove(png); n += 1
keep = set(lib.EXPORTED)
for f in os.listdir(os.path.join(OUT, 'img')):
    if f not in keep: os.remove(os.path.join(OUT, 'img', f)); print('removed stale', f)

ts = ('// Generated by scripts/looks/export.py (npm run looks). Do not edit by hand.\n'
      '// Google Fonts families (css2 `family=` values) each template\'s looks need.\n'
      'export const LOOK_FONTS = {\n' + ''.join(f"  {t}: {fonts_by_tpl[t]!r},\n" for t in fonts_by_tpl).replace("'", '"') + '} as const;\n')
with open(os.path.join(ROOT, 'src', 'lib', 'looks-fonts.ts'), 'w') as f: f.write(ts)
print('photos converted', n, 'used', len(keep), 'phones', sum(len(i[4]) for i in T))
