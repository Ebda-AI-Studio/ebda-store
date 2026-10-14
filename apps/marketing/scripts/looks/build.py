import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import lib
from lib import BASE
from catalog import T, FONTS

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist', 'gallery.html')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

half = len(FONTS) // 2
def flink(fs): return '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' + '&amp;'.join('family=' + f for f in fs) + '&amp;display=swap">'

phone_css, panels, tabs = [], [], []
n_phones = 0
for ti, (tid, en, ar, vert, items) in enumerate(T):
    figs = ''
    for fn, letter, name, purpose, idea in items:
        lib.CUR[0] = fn.__name__
        css, html = fn()
        pid = f'ph-{tid}-{letter.lower()}'
        phone_css.append((BASE + css).replace('&', '#' + pid))
        figs += (f'<figure class="item"><div class="phone"><span class="tag">صور توضيحية / illustrative</span>'
                 f'<div class="scr" id="{pid}" dir="rtl" lang="ar" tabindex="0" role="region" aria-label="{en} {letter} {name}">{html}</div></div>'
                 f'<figcaption><h3><span class="L">{letter}</span> {name}</h3><p>{purpose}</p><p class="idea"><b>Bold idea.</b> {idea}</p></figcaption></figure>')
        n_phones += 1
    sel = 'true' if ti == 0 else 'false'
    tabs.append(f'<button role="tab" id="t-{tid}" aria-controls="p-{tid}" aria-selected="{sel}" tabindex="{0 if ti == 0 else -1}" type="button">{en} <span class="ar" lang="ar">{ar}</span></button>')
    panels.append(f'<section role="tabpanel" id="p-{tid}" aria-labelledby="t-{tid}"{"" if ti == 0 else " hidden"}><h2>{en} <small>{vert}</small></h2><div class="trio">{figs}</div></section>')

CHROME = """
:root{--bg:#eceef1;--panel:#ffffff;--ink:#16191d;--mut:#586070;--line:#d3d8df;--acc:#2b4a8a;--frame:#15171a}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#121418;--panel:#1b1e24;--ink:#e8eaee;--mut:#a3abb8;--line:#2d323b;--acc:#9db6f2;--frame:#05060a;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121418;--panel:#1b1e24;--ink:#e8eaee;--mut:#a3abb8;--line:#2d323b;--acc:#9db6f2;--frame:#05060a;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Tajawal,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.55}
.wrap{max-width:1360px;margin:0 auto;padding:28px 16px 64px}
.top h1{font-size:24px;margin:0 0 4px;font-weight:700}
.top p{margin:0;color:var(--mut);max-width:70ch}
[role=tablist]{display:flex;gap:6px;flex-wrap:wrap;margin:22px 0 8px;border-bottom:1px solid var(--line)}
[role=tab]{font:inherit;font-weight:500;padding:10px 18px;min-height:44px;background:none;border:0;border-bottom:3px solid transparent;color:var(--mut);cursor:pointer;margin-bottom:-1px}
[role=tab][aria-selected=true]{color:var(--ink);border-color:var(--acc);font-weight:700}
[role=tab]:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}
.ar{font-weight:700}
[role=tabpanel] h2{font-size:20px;margin:22px 0 4px}
[role=tabpanel] h2 small{font-size:15px;font-weight:400;color:var(--mut);margin-inline-start:8px}
.trio{display:flex;flex-wrap:wrap;gap:36px 28px;justify-content:center;margin-top:18px}
.item{margin:0;width:min(402px,100%)}
figcaption{padding:14px 4px 0}
figcaption h3{margin:0;font-size:18px}
figcaption .L{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--ink);color:var(--bg);font-size:14px;margin-inline-end:6px}
figcaption p{margin:6px 0 0;color:var(--mut);font-size:15px}
figcaption .idea b{color:var(--ink)}
.phone{position:relative;width:100%;padding:30px 6px 6px;background:var(--frame);border-radius:30px}
.tag{position:absolute;top:5px;left:50%;transform:translateX(-50%);z-index:10;font-size:12px;line-height:1;white-space:nowrap;color:#fff;background:#2a2d33;padding:5px 12px;border-radius:999px;pointer-events:none}
.scr{height:min(844px,calc(100svh - 120px));min-height:560px;border-radius:24px;overflow-y:auto}
.scr:focus-visible{outline:3px solid #7aa2ff;outline-offset:-3px}
@media (max-width:440px){.wrap{padding-top:20px}.item{width:100%}}
@media (prefers-reduced-motion: no-preference){.scr{scroll-behavior:smooth}}
"""

JS = """
(function(){
 var tabs=[].slice.call(document.querySelectorAll('[role=tab]')),KEY='ebda-directions-tab';
 function show(id,focus){tabs.forEach(function(t){var on=t.id===id;t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1;
  document.getElementById(t.getAttribute('aria-controls')).hidden=!on;if(on&&focus)t.focus();});
  try{localStorage.setItem(KEY,id)}catch(e){}}
 tabs.forEach(function(t,i){t.addEventListener('click',function(){show(t.id)});
  t.addEventListener('keydown',function(e){var n=null;if(e.key==='ArrowRight')n=tabs[(i+1)%tabs.length];if(e.key==='ArrowLeft')n=tabs[(i-1+tabs.length)%tabs.length];
   if(n){e.preventDefault();show(n.id,true)}})});
 var saved=null;try{saved=localStorage.getItem(KEY)}catch(e){}
 if(saved&&document.getElementById(saved)&&saved.indexOf('t-')===0)show(saved);
 document.addEventListener('click',function(e){
  var c=e.target.closest&&e.target.closest('.scr .chip');
  if(c){[].forEach.call(c.parentNode.querySelectorAll('.chip'),function(x){x.classList.remove('on')});c.classList.add('on');return}
  var m=e.target.closest&&e.target.closest('.scr .cmp');if(m){m.setAttribute('aria-pressed',m.getAttribute('aria-pressed')==='true'?'false':'true');return}
  var d=e.target.closest&&e.target.closest('.scr .day');if(d){[].forEach.call(d.parentNode.querySelectorAll('.day'),function(x){x.classList.remove('on')});d.classList.add('on');return}
  var a=e.target.closest&&e.target.closest('.scr a[href="#"]');if(a)e.preventDefault();
 });
})();
"""

out = ('<title>Ebda Store Template Directions</title>\n<meta charset="utf-8">\n<style>' + CHROME + '\n' + '\n'.join(phone_css) + '\n' + ''.join('.i-%s{background-image:url(%s)}' % (k, v) for k, v in lib.USED.items()) + '</style>\n'
       '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
       + flink(FONTS[:half]) + '\n' + flink(FONTS[half:]) + '\n'
       '<div class="wrap"><header class="top"><h1>Ebda Store: template directions, round 1</h1>'
       '<p>Five templates, three directions each. Scroll inside any phone to see the whole home page, then pick one direction per template. Photos are illustrative placeholders, not real stock.</p></header>'
       '<div role="tablist" aria-label="Templates">' + ''.join(tabs) + '</div>' + ''.join(panels) + '</div>\n<script>' + JS + '</script>\n')
open(OUT, 'w').write(out)

# report
bad = [c for c in lib.CHECKS if c[3] < 4.5]
print('photos', lib.STATS, 'phones', n_phones, 'bytes', len(out.encode()))
print('contrast checks', len(lib.CHECKS), 'below 4.5:', [(l, f, b, round(r, 2)) for l, f, b, r in bad])
print('auto-adjusted text colours:')
for a in lib.ADJ: print('  ', a)
