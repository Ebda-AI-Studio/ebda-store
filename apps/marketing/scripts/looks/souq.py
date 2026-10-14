from lib import *
from art import o_lantern

# ====================== SOUQ A · CATALOGUE ======================
def sa():
    W, INK, COB = '#ffffff', '#10151c', '#1f5fd6'
    MUT = '#566070'; chk('SA muted', MUT, W); chk('SA cobalt', COB, W); ONC = on(COB, INK, '#fff', 'SA on cobalt')
    cw = lambda c, d, a: ('#f3f5f8', '#f3f5f8', c, d, a)
    P = {'phone': cw('#1b2430', '#9db7e8', COB), 'laptop': cw('#c9ced6', '#1b2430', COB), 'headphones': cw('#1b2430', '#313c4d', COB),
         'watch': cw('#2b3340', '#454f60', COB), 'tablet': cw('#cfd4dc', '#1b2430', COB), 'powerbank': cw('#1b2430', '#c9ced6', COB),
         'speaker': cw('#2b3340', '#566070', COB), 'earbuds': cw('#e6e9ee', '#9aa3b0', COB)}
    ic = lambda k, n: img(k, P[k], n, 1.15)
    cats = [('موبايلات', 'phone'), ('لاب توب', 'laptop'), ('سماعات', 'headphones'), ('ساعات', 'watch'), ('تابلت', 'tablet'), ('إكسسوارات', 'powerbank')]
    rail = ''.join(f'<a class="ct" href="#"><div class="ph">{ic(k, n)}</div><span>{n}</span></a>' for n, k in cats)
    deals = [('هاتف ذكي 6.7 بوصة', 14999, 16500, 'phone'), ('سماعة لاسلكية', 1299, 1650, 'headphones'), ('ساعة ذكية', 3450, 3900, 'watch'), ('تابلت 10 بوصة', 9800, 11200, 'tablet')]
    dl = ''.join(f'<article class="dc"><div class="ph" style="aspect-ratio:1/1">{ic(k, n)}</div><span class="off">-{round((o - p) * 100 / o)}%</span>'
                 f'<h3 class="nm">{n}</h3>{price(p, o)}</article>' for n, p, o, k in deals)
    prods = [('هاتف ذكي أندرويد 6.7 بوصة', 14999, 16500, 'phone', ['256GB', '8GB RAM']), ('لاب توب للدراسة 15.6 بوصة', 24900, None, 'laptop', ['512GB', '16GB RAM']),
             ('سماعة بلوتوث عازلة للضوضاء', 2150, 2600, 'headphones', ['30 ساعة', 'Bluetooth 5.3']), ('ساعة ذكية رياضية', 3450, None, 'watch', ['GPS', 'مقاومة للماء']),
             ('تابلت للرسم والقراءة', 9800, 11200, 'tablet', ['128GB', '6GB RAM']), ('باور بانك سريع الشحن', 749, None, 'powerbank', ['20000mAh', '65W']),
             ('سماعة أذن لاسلكية', 1299, 1650, 'earbuds', ['حافظة شحن', '24 ساعة']), ('سبيكر محمول ضد المياه', 1850, None, 'speaker', ['IPX7', '12 ساعة'])]
    cards = ''.join(f'<article class="pc"><div class="ph" style="aspect-ratio:1/1">{ic(k, n)}</div><h3 class="nm">{n}</h3>'
                    f'<div class="chs">{"".join(f"<span>{s}</span>" for s in sp)}</div><div class="pr"><div>{price(p, o)}</div>'
                    f'<button class="qa" type="button" aria-label="إضافة {n}">{I("plus", 18)}</button></div></article>' for n, p, o, k, sp in prods)
    css = f"""
&{{--bg:#fff;--ink:{INK};--mut:{MUT};--ac:{COB};--fd:'IBM Plex Sans Arabic';--fb:'IBM Plex Sans Arabic';--fl:'IBM Plex Sans'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;padding:6px 10px 0 6px;position:sticky;top:0;background:#fff;z-index:3}}
& .logo{{font-size:30px;font-weight:700;display:flex;align-items:baseline;gap:8px;line-height:1.2;padding-inline-start:10px}}
& .logo i{{font-family:var(--fl),sans-serif;font-style:normal;font-size:13px;letter-spacing:.22em;color:{COB};font-weight:600}}
& .srch{{margin:6px 16px 14px;height:48px;border-radius:10px;background:#eef1f5;display:flex;align-items:center;gap:10px;padding:0 14px;color:{MUT};font-size:14px;border:0;width:calc(100% - 32px)}}
& .rail{{display:flex;gap:14px;overflow-x:auto;padding:4px 16px 16px;scrollbar-width:none}}
& .ct{{flex:none;width:76px;text-align:center;font-size:13px;font-weight:600}}
& .ct .ph{{width:76px;height:76px;border-radius:50%;margin-bottom:4px}}
& .sec{{padding:10px 0 4px}}
& .sec>h2{{padding:0 16px 10px;font-size:19px}}
& .sec>h2 em{{font-style:normal;color:{COB}}}
& .dc{{flex:none;width:150px;position:relative}}
& .dc .ph{{border-radius:10px}}
& .off{{position:absolute;top:6px;inset-inline-start:6px;background:{COB};color:{ONC};font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:18px 10px;padding:0 16px 120px}}
& .pc .ph{{border-radius:10px}}
& .pc .nm{{margin-top:6px}}
& .chs{{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 6px}}
& .chs span{{font-size:12px;background:#eef1f5;padding:1px 8px;border-radius:999px;color:#364152}}
& .pr{{display:flex;justify-content:space-between;align-items:center}}
& .qa{{width:40px;height:40px;border-radius:10px;border:0;background:{COB};color:{ONC};display:grid;place-items:center;padding:0}}
& .cart{{position:sticky;bottom:0;margin:0;padding:10px 16px;background:#10151c;color:#fff;display:flex;justify-content:space-between;align-items:center;z-index:4}}
& .cart b{{font-size:16px}}
& .cart span{{font-size:13px;color:#cdd5e1}}
& .cart a{{background:{COB};color:{ONC};padding:10px 20px;border-radius:10px;font-weight:700;font-size:14px}}
"""
    html = f"""<header class="hd"><div class="logo">سوق <i>SOUQ</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<button class="srch" type="button">{I('search', 20)} ابحث عن موبايل، لاب توب، سماعة...</button>
<nav class="rail" aria-label="الأقسام">{rail}</nav>
<section class="sec"><h2>عروض النهاردة <em>لحد 12 بالليل</em></h2><div class="row">{dl}</div></section>
<section class="sec" style="padding-top:20px"><h2>كل المنتجات</h2><div class="g2">{cards}</div></section>
{footer('#10151c', '#ffffff', '#c3ccd9', 'سوق', 'إلكترونيات أصلية بضمان، من وسط البلد لحد باب بيتك.', ['من نحن', 'الضمان', 'الشحن والاسترجاع', 'تواصل معنا'])}
<div class="cart"><div><b>14,999 ج.م</b><br><span>سلتك فيها 2 منتجات</span></div><a href="#">كمّل الطلب</a></div>"""
    return css, html


# ====================== SOUQ B · NIGHT SOUQ ======================
def sb():
    G, G2, TX, BR, OR = '#0f3b2e', '#14503f', '#f6f3ea', '#c89b3c', '#e2702b'
    MUT = fix('#a9c4b6', G2, 4.5, 'SB muted'); chk('SB text', TX, G); chk('SB brass', BR, G)
    BRT = fix(BR, G2, 4.5, 'SB brass price on tile'); ONB = on(BR, '#10151c', '#fff', 'SB on brass'); ONO = on(OR, '#10151c', '#fff', 'SB on orange')
    cw = lambda c, d, a: (G2, '#0c3226', c, d, a)
    P = {'speaker': cw(BR, '#10151c', OR), 'headphones': cw('#f6f3ea', '#10151c', BR), 'tablet': cw('#c7d3cc', '#10151c', BR), 'powerbank': cw(BR, '#10151c', '#f6f3ea'),
         'watch': cw('#e9dcb8', '#6d5320', BR), 'phone': cw('#f6f3ea', '#10151c', BR), 'laptop': cw('#c7d3cc', '#10151c', BR), 'earbuds': cw('#f6f3ea', '#4a5a52', BR)}
    lant = ''.join(f'<g transform="translate({x} {y}) scale({s})" opacity="{o}">{o_lantern("#c89b3c", "#6d5320", "#e2a54b")}</g>' for x, y, s, o in [(-30, -30, .5, 1), (200, -20, .42, 1), (206, 110, .3, .7), (-10, 130, .28, .7)])
    hero = img('speaker', ('#1a5a47', '#071f17', BR, '#10151c', OR), 'سبيكر محمول', 1.0, lant, pk='hero')
    cats = [('موبايلات', 'phone'), ('سماعات', 'headphones'), ('تابلت', 'tablet'), ('ساعات', 'watch'), ('لاب توب', 'laptop'), ('باور بانك', 'powerbank')]
    tiles = ''.join(f'<a class="tl" href="#"><div class="ph">{img(k, P[k], n, 1.1)}</div><span>{n}</span></a>' for n, k in cats)
    def rowc(items): return ''.join(f'<article class="rc"><div class="ph" style="aspect-ratio:1/1">{img(k, P[k], n)}</div><h3 class="nm">{n}</h3>{price(p, o)}</article>' for n, p, o, k in items)
    r1 = [('سبيكر خشبي بإضاءة', 1850, None, 'speaker'), ('سماعة رأس استوديو', 2400, None, 'headphones'), ('ساعة كلاسيك ذكية', 3450, None, 'watch'), ('تابلت للقراءة', 6200, None, 'tablet')]
    r2 = [('باور بانك 20000', 749, 900, 'powerbank'), ('سماعة أذن صغيرة', 1299, 1650, 'earbuds'), ('هاتف اقتصادي', 7800, 8600, 'phone'), ('لاب توب خفيف', 21900, 24000, 'laptop')]
    grid = ''.join(f'<article class="gc"><div class="ph" style="aspect-ratio:1/1">{img(k, P[k], n)}</div>' + (f'<span class="deal">عرض</span>' if o else '') +
                   f'<h3 class="nm">{n}</h3><div class="pr"><div>{price(p, o)}</div><button class="qa" type="button" aria-label="إضافة {n}">{I("plus", 18)}</button></div></article>'
                   for n, p, o, k in r1 + r2)
    css = f"""
&{{--bg:{G};--ink:{TX};--mut:{MUT};--ac:{BR};--fd:'Changa';--fb:'Cairo';--fl:'Manrope'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;padding:0 8px;height:72px;background:{G};position:sticky;top:0;z-index:3;border-bottom:1px solid #ffffff1a}}
& .logo{{font-family:var(--fd),sans-serif;font-size:36px;font-weight:700;color:{BR};line-height:1;display:flex;align-items:baseline;gap:8px}}
& .logo i{{font-family:var(--fl),sans-serif;font-style:normal;font-size:13px;letter-spacing:.3em;color:{TX};font-weight:600}}
& .hero .ph{{aspect-ratio:1/1.05}}
& .hc{{padding:18px 20px 26px}}
& .hc h2{{font-size:32px;color:{TX}}}
& .hc p{{color:{TX};margin-top:2px}}
& .cta{{display:inline-block;margin-top:12px;padding:11px 24px;background:{BR};color:{ONB};font-weight:700;border-radius:8px}}
& .sec{{padding:22px 0 8px}}
& .sec>h2{{padding:0 16px 12px;font-size:24px}}
& .tiles{{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 16px}}
& .tl{{background:{G2};border-radius:8px;text-align:center;padding:6px 6px 10px;font-weight:600;font-size:13px}}
& .tl .ph{{aspect-ratio:1/1;border-radius:6px;margin-bottom:4px}}
& .rc{{flex:none;width:140px}}
& .rc .ph{{border-radius:8px}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:16px 10px;padding:0 16px 30px}}
& .gc{{background:{G2};border-radius:8px;padding:8px 8px 10px;position:relative}}
& .gc .ph{{border-radius:6px;margin-bottom:6px}}
& .deal{{position:absolute;top:14px;inset-inline-start:14px;background:{OR};color:{ONO};font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px}}
& .gc .price{{color:{BRT}}}
& .rc .price{{color:{BR}}}
& .pr{{display:flex;justify-content:space-between;align-items:center}}
& .qa{{width:40px;height:40px;border-radius:8px;border:0;background:{BR};color:{ONB};display:grid;place-items:center;padding:0}}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button><div class="logo">سوق <i>SOUQ</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<section class="hero"><div class="ph">{hero}</div><div class="hc"><h2>سبيكر الليل: صوت بيملا الأوضة</h2><p>إضاءة دافية وبطارية 12 ساعة، بـ 1,850 ج.م بس.</p><a class="cta" href="#">اطلبه دلوقتي</a></div></section>
<section class="sec"><h2>الأقسام</h2><div class="tiles">{tiles}</div></section>
<section class="sec"><h2>من السوق: اختيارات الأسبوع</h2><div class="row">{rowc(r1)}</div></section>
<section class="sec"><h2>من السوق: لو محتاج حاجة سريعة</h2><div class="row">{rowc(r2)}</div></section>
<section class="sec"><h2>كل المنتجات</h2><div class="g2">{grid}</div></section>
{footer('#0a2a20', '#f6f3ea', '#b9d0c4', 'سوق', 'سوق إلكتروني بروح خان الخليلي.', ['من نحن', 'الضمان', 'الشحن والاسترجاع', 'تواصل معنا'])}"""
    return css, html


# ====================== SOUQ C · SHOWROOM ======================
def sc():
    BG, TILE, INK, EL = '#f2f3f5', '#e6e8eb', '#0b0c0e', '#2a6bff'
    MUT = fix('#5b616b', TILE, 4.5, 'SC muted'); ACT = fix(EL, BG, 4.5, 'SC accent text'); BTN = fix(EL, '#ffffff', 4.5, 'SC button fill'); ONB = on(BTN, INK, '#fff', 'SC on btn')
    cw = lambda c, d, a: (BG, BG, c, d, a); ct = lambda c, d, a: (TILE, TILE, c, d, a)
    A = ('#1b1d21', '#8fb0f5', EL)
    def hero(kind, name, spec, p, old=None, c=A):
        return (f'<section class="hs"><div class="ph hi">{img(kind, cw(*c), name, 1.35)}</div><h2>{name}</h2><p class="spec">{spec}</p>'
                f'<div class="hp">{price(p, old)}</div><div class="acts"><a class="buy" href="#">أضف للسلة</a>'
                f'<button class="cmp" type="button" aria-pressed="false">{I("check", 18)} قارن</button></div></section>')
    cats = [('موبايلات', 'phone', ('#1b1d21', '#8fb0f5', EL)), ('لاب توب', 'laptop', ('#c9ced6', '#1b1d21', EL)), ('سماعات', 'headphones', ('#1b1d21', '#3a3e45', EL)),
            ('ساعات', 'watch', ('#2b2f36', '#4b505a', EL)), ('تابلت', 'tablet', ('#cfd4dc', '#1b1d21', EL)), ('إكسسوارات', 'earbuds', ('#e9ebee', '#9aa0aa', EL))]
    ctiles = ''.join(f'<a class="tl" href="#"><div class="ph">{img(k, ct(*c), n, 1.15)}</div><span>{n}</span></a>' for n, k, c in cats)
    prods = [('هاتف ذكي 6.1 بوصة', 21900, None, 'phone', ('#1b1d21', '#8fb0f5', EL)), ('لاب توب نحيف', 31500, 34000, 'laptop', ('#c9ced6', '#1b1d21', EL)),
             ('سماعة عازلة للضوضاء', 4200, None, 'headphones', ('#1b1d21', '#3a3e45', EL)), ('ساعة ذكية 45mm', 6900, None, 'watch', ('#2b2f36', '#4b505a', EL)),
             ('تابلت 11 بوصة', 15800, 17200, 'tablet', ('#cfd4dc', '#1b1d21', EL)), ('سماعة أذن لاسلكية', 2800, None, 'earbuds', ('#e9ebee', '#9aa0aa', EL))]
    cards = ''.join(f'<article><div class="ph pi">{img(k, cw(*c), n, 1.1)}</div><h3 class="nm">{n}</h3><div class="pr"><div>{price(p, o)}</div>'
                    f'<button class="qa" type="button" aria-label="إضافة {n}">{I("plus", 18)}</button></div></article>' for n, p, o, k, c in prods)
    css = f"""
&{{--bg:{BG};--ink:{INK};--mut:{MUT};--ac:{ACT};--fd:'Alexandria';--fb:'Readex Pro';--fl:'Inter Tight'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;padding:0 6px;height:64px;position:sticky;top:0;background:#f2f3f5ee;z-index:3}}
& .logo{{font-family:var(--fd),sans-serif;font-size:30px;font-weight:700;display:flex;align-items:baseline;gap:8px;line-height:1}}
& .logo i{{font-family:var(--fl),sans-serif;font-style:normal;font-size:13px;letter-spacing:.24em;color:{MUT};font-weight:500}}
& .hs{{text-align:center;padding:20px 24px 36px;min-height:620px}}
& .hi{{aspect-ratio:1/1.05;margin:0 -24px 8px;background:{BG}}}
& .hs h2{{font-size:30px}}
& .spec{{color:{MUT};font-size:14px;margin-top:2px}}
& .hp{{margin:10px 0 14px}} & .hp .price{{font-size:17px}}
& .acts{{display:flex;gap:10px;justify-content:center}}
& .buy{{background:{BTN};color:{ONB};padding:12px 28px;border-radius:999px;font-weight:600;font-size:14px;min-height:44px;display:inline-flex;align-items:center}}
& .cmp{{border:1.5px solid {INK};background:transparent;border-radius:999px;padding:0 20px;min-height:44px;font-size:14px;display:inline-flex;align-items:center;gap:6px}}
& .cmp svg{{opacity:.35}}
& .cmp[aria-pressed=true]{{background:{INK};color:#fff}} & .cmp[aria-pressed=true] svg{{opacity:1}}
& .cats{{padding:20px 16px 34px}}
& .cats>h2{{font-size:24px;margin-bottom:12px}}
& .tiles{{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}}
& .tl{{background:{TILE};border-radius:12px;text-align:center;padding:8px 6px 12px;font-weight:500;font-size:13px}}
& .tl .ph{{aspect-ratio:1/1;margin-bottom:4px;border-radius:8px}}
& .shop{{padding:0 16px 30px}}
& .shop>h2{{font-size:24px;margin-bottom:12px}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:20px 10px}}
& .pi{{aspect-ratio:1/1.05;border-radius:12px}}
& .g2 .nm{{margin-top:6px}}
& .pr{{display:flex;justify-content:space-between;align-items:center}}
& .qa{{width:40px;height:40px;border-radius:50%;border:0;background:{BTN};color:{ONB};display:grid;place-items:center;padding:0}}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button><div class="logo">سوق <i>SOUQ</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
{hero('phone', 'هاتف ذكي 6.1 بوصة', 'كاميرا 50 ميجا · 256GB · شحن 30 دقيقة', 21900)}
{hero('laptop', 'لاب توب نحيف 14 بوصة', 'بطارية 18 ساعة · 16GB RAM · 512GB', 31500, 34000, ('#c9ced6', '#1b1d21', EL))}
<section class="cats"><h2>تسوّق حسب القسم</h2><div class="tiles">{ctiles}</div></section>
<section class="shop"><h2>كل المنتجات</h2><div class="g2">{cards}</div></section>
{footer('#0b0c0e', '#ffffff', '#c1c4ca', 'سوق', 'منتج واحد في كل شاشة، من غير زحمة.', ['من نحن', 'الضمان', 'الشحن والاسترجاع', 'تواصل معنا'])}"""
    return css, html
