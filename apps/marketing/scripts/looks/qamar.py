from lib import *

# ====================== QAMAR A · ATELIER ======================
def qa():
    W, INK, MUT, OX = '#ffffff', '#141414', '#5c5c5c', '#6e1f2a'
    chk('A price', OX, W); chk('A muted', MUT, W)
    cw = [('#f1efee', '#e4e1df', '#fafafa', '#cfcac6', OX),      # white linen
          ('#ececec', '#dcdcdc', '#1c1c1c', '#3a3a3a', '#bdbdbd'),
          ('#f0e9e9', '#e2d5d6', OX, '#521620', '#e9d3d6'),
          ('#efeeec', '#e0ddd8', '#3d3a36', '#242220', '#d8d2c8')]
    hero = img('figure', ('#f7f7f7', '#e6e4e2', '#fafafa', '#ccc', OX), 'عارضة بقميص كتان أبيض', 1.55, pk='hero', extra=
               '<rect x="38" y="60" width="4" height="280" fill="#141414" opacity=".25"/><rect x="38" y="64" width="224" height="4" fill="#141414" opacity=".3"/>')
    brk = img('coat', ('#e8e6e3', '#d4d0cb', '#2a2826', '#141414', OX), 'جاكيت طويل', 1.5)
    prods = [('قميص كتان أبيض', 1450, None, 'shirt', 0), ('بنطلون واسع أسود', 1150, 1400, 'trousers', 1),
             ('فستان ميدي عنابي', 2300, None, 'dress', 2), ('جاكيت قطن طويل', 2750, None, 'coat', 3),
             ('حقيبة جلد طبيعي', 3200, None, 'bag', 3), ('قميص بوبلين مخطط', 1250, 1500, 'shirt', 1),
             ('شال حرير', 890, 1100, 'dress', 2), ('بنطلون كتان بيج', 1350, None, 'trousers', 0)]
    SZ = 'S|M|L|XL'
    meta = {'قميص كتان أبيض': dict(cat='shirts', sizes=SZ, colors='أبيض:#f4f4f2|بيج:#d8c9b0', desc='كتان 100% · قصّة واسعة · بيتغسل في الغسالة'),
            'بنطلون واسع أسود': dict(cat='trousers', sizes=SZ, colors='أسود:#1c1c1c|رمادي:#8a8a8a', desc='قماش ثقيل بيقف لوحده · خصر عالي'),
            'فستان ميدي عنابي': dict(cat='dresses', sizes=SZ, colors='عنابي:#6e1f2a|أسود:#1c1c1c', desc='طول تحت الركبة · بطانة قطن · جيوب'),
            'جاكيت قطن طويل': dict(cat='jackets', sizes=SZ, colors='بيج:#cbbca4|أسود:#1c1c1c', desc='قطن ثقيل · بطانة داخلية · قصّة مستقيمة'),
            'حقيبة جلد طبيعي': dict(cat='bags', colors='بني:#6b4a35|أسود:#1c1c1c', desc='جلد طبيعي · سوستة معدن · تتحمل لاب توب 13 بوصة'),
            'قميص بوبلين مخطط': dict(cat='shirts', sizes=SZ, colors='أزرق:#9db3d6|أبيض:#f4f4f2', desc='بوبلين قطن ناعم · ياقة كلاسيك'),
            'شال حرير': dict(cat='acc', colors='عنابي:#6e1f2a|ذهبي:#c9a45c', desc='حرير طبيعي · 90 × 90 سم · حواف مخيّطة يدوي'),
            'بنطلون كتان بيج': dict(cat='trousers', sizes=SZ, colors='بيج:#d8c9b0', desc='كتان خفيف للصيف · رِجل واسعة')}
    cards = ''.join(f'<article {pd(n, p, o, k, **meta[n])}><div class="ph" style="aspect-ratio:3/4">{img(k, cw[c], n)}</div>'
                    f'<h3 class="nm" style="margin-top:8px;padding-inline:8px">{n}</h3><div style="padding-inline:8px">{price(p, o)}</div></article>'
                    for n, p, o, k, c in prods)
    chips = ''.join(f'<button class="chip{" on" if i == 0 else ""}" type="button" data-cat="{k}">{t}</button>' for i, (t, k) in enumerate(
        [('الكل', 'all'), ('قمصان', 'shirts'), ('فساتين', 'dresses'), ('بناطيل', 'trousers'), ('جاكيتات', 'jackets'), ('شنط', 'bags'), ('إكسسوارات', 'acc')]))
    css = """
&{--bg:#fff;--ink:#141414;--mut:#5c5c5c;--ac:#6e1f2a;--btn:#141414;--btnfg:#fff;--r:0px;--rb:0px;--ga:3/4;--fd:'Noto Naskh Arabic';--fb:'IBM Plex Sans Arabic';--fl:'Cormorant Garamond'}
& .hd{display:grid;grid-template-columns:48px 1fr 48px;align-items:center;height:68px;padding:0 6px;position:sticky;top:0;background:#fff;z-index:3;border-bottom:1px solid #ececec}
& .logo{text-align:center;line-height:1.05}
& .logo b{display:block;font-family:var(--fd),serif;font-size:36px;font-weight:700}
& .logo i{font-family:var(--fl),serif;font-style:normal;font-size:13px;letter-spacing:.34em;color:var(--mut);font-weight:600}
& .cap{padding:18px 20px 6px}
& .cap h2{font-size:30px}
& .cap p{color:var(--mut);font-size:14px;margin-top:4px}
& .cta{display:inline-block;margin-top:12px;padding:10px 22px;background:var(--ink);color:#fff;font-size:14px;font-weight:600}
& .chips{display:flex;gap:8px;overflow-x:auto;padding:16px;scrollbar-width:none}
& .chip{white-space:nowrap;padding:8px 16px;border-radius:999px;border:1px solid #cfcfcf;background:#fff;font-size:13px;min-height:40px}
& .chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
& .g2{display:grid;grid-template-columns:1fr 1fr;gap:22px 3px}
& .g2 .price{color:var(--ac)}
& .brk{margin-top:28px}
& .brk .cap{padding-bottom:26px}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة" data-open-menu>{I('menu')}</button>
<div class="logo"><b>قمر</b><i>QAMAR</i></div><button class="ib" type="button" aria-label="السلة" data-open-cart>{I('bag')}</button></header>
<section><div class="ph" style="aspect-ratio:3/4.05">{hero}</div>
<div class="cap"><h2>كتان الصيف، بقصّة هادية</h2><p>مجموعة أتيليه زمالك الجديدة، قطع قليلة ومتقنة.</p><a class="cta" href="#">تسوّقي المجموعة</a></div></section>
<nav class="chips" aria-label="الأقسام">{chips}</nav>
<section class="g2" data-grid>{cards}</section>
<section class="brk"><div class="ph" style="aspect-ratio:1/1">{brk}</div>
<div class="cap"><h2>جاكيتات للشتا الجاي</h2><p>قطن ثقيل وصوف مخلوط، اطلبيها دلوقتي واستلميها قبل أول موجة برد.</p><a class="cta" href="#">شوفي الجاكيتات</a></div></section>
{footer('#141414', '#ffffff', '#c9c9c9', 'قمر', 'أزياء نسائية مختارة من قلب الزمالك.', ['من نحن', 'المقاسات', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html


# ====================== QAMAR B · LOOKBOOK ======================
def qb():
    IND, IND2, TX, SAF = '#1e2340', '#2a3158', '#f4f1fa', '#e8a33d'
    MUT = fix('#b9b6cf', IND2, 4.5, 'QB muted')
    chk('QB text', TX, IND); chk('QB saffron on indigo', SAF, IND); chk('QB btn', IND, SAF)
    cwl = [('#3b3f6b', '#1e2340', '#e8a33d', '#c6841c', '#f4f1fa'), ('#4a3760', '#241a38', '#f4f1fa', '#cdbfe0', '#e8a33d'),
           ('#2d4a5a', '#1b2e3a', '#1e2340', '#0f1730', '#e8a33d'), ('#533a52', '#2a1c2c', '#e8a33d', '#a8711a', '#f4f1fa')]
    collage = (f'<div class="cl c1 ph">{img("figure", cwl[0], "إطلالة سطوح", 1.6)}</div>'
               f'<div class="cl c2 ph">{img("dress", cwl[3], "فستان زعفراني", 1.3)}</div>'
               f'<div class="cl c3 ph">{img("sneaker", cwl[2], "سنيكرز", 1.2)}</div>')
    looks = [('إطلالة السطوح', cwl[0], [('جاكيت إنديجو', 2100, 'coat'), ('بنطلون جينز', 1350, 'trousers'), ('سنيكرز جلد', 1800, 'sneaker')], 'figure'),
             ('سهرة الخميس', cwl[3], [('فستان زعفراني', 2600, 'dress'), ('كعب عالي', 1900, 'heels'), ('حقيبة يد', 1400, 'bag')], 'dress'),
             ('كاجوال الجمعة', cwl[1], [('قميص أوفر سايز', 950, 'shirt'), ('بنطلون واسع', 1150, 'trousers'), ('سنيكرز أبيض', 1650, 'sneaker')], 'shirt')]
    lk = ''
    for t, cw, items, k in looks:
        tot = sum(p for _, p, _ in items)
        li = ''.join(f'<li><span>{n}</span><b>{fmt(p)}</b></li>' for n, p, _ in items)
        lk += (f'<article class="look"><div class="ph" style="aspect-ratio:4/3.6">{img(k, cw, t, 1.35)}</div>'
               f'<div class="lb"><h3>{t}</h3><ul>{li}</ul><button type="button" class="btn" {bundle(items)}>{I("plus", 18)} أضيفي اللوك كامل · {fmt(tot)}</button></div></article>')
    prods = [('تيشيرت قطن', 650, 790, 'shirt', 0), ('جاكيت جلد صناعي', 2350, None, 'coat', 1), ('بنطلون كارجو', 1250, None, 'trousers', 2),
             ('فستان كاجوال', 1550, 1900, 'dress', 3), ('حقيبة كروس', 1100, None, 'bag', 0), ('سنيكرز كانفاس', 1450, None, 'sneaker', 2)]
    SZ = 'S|M|L|XL'
    meta = {'تيشيرت قطن': dict(sizes=SZ, colors='أبيض:#f4f1fa|إنديجو:#2a3158', desc='قطن 100% · قصّة أوفر سايز'),
            'جاكيت جلد صناعي': dict(sizes=SZ, colors='أسود:#16161c|بني:#5a3b2a', desc='جلد صناعي ناعم · بطانة · جيوب سوستة'),
            'بنطلون كارجو': dict(sizes=SZ, colors='زيتي:#4a5a3a|أسود:#16161c', desc='6 جيوب · خصر مطاطي مخفي'),
            'فستان كاجوال': dict(sizes=SZ, colors='زعفراني:#e8a33d|إنديجو:#2a3158', desc='قماش خفيف · طول ميدي · أكمام قصيرة'),
            'حقيبة كروس': dict(colors='أسود:#16161c|زعفراني:#e8a33d', desc='حزام قابل للتعديل · مساحة للموبايل والمحفظة'),
            'سنيكرز كانفاس': dict(sizes='38|39|40|41|42|43', colors='أبيض:#f4f1fa|أسود:#16161c', desc='كانفاس سميك · نعل مطاط · مريح لليوم كله')}
    cards = ''.join(f'<article {pd(n, p, o, k, **meta[n])}><div class="ph" style="aspect-ratio:1/1.15">{img(k, cwl[c], n)}</div><h3 class="nm" style="margin-top:8px">{n}</h3>'
                    f'<div class="pr">{price(p, o)}<button class="qa" type="button" aria-label="إضافة {n}" data-add>{I("plus", 18)}</button></div></article>' for n, p, o, k, c in prods)
    css = """
&{--bg:#1e2340;--ink:#f4f1fa;--mut:""" + MUT + """;--ac:#e8a33d;--btn:#e8a33d;--btnfg:#1e2340;--r:10px;--rb:999px;--ga:4/4.6;--fd:'Lalezar';--fb:'Tajawal';--fl:'Archivo'}
& .hd{display:flex;align-items:center;justify-content:space-between;padding:0 8px;height:68px;background:#1e2340;position:sticky;top:0;z-index:3}
& .logo{font-family:var(--fd),sans-serif;font-size:38px;line-height:1;display:flex;align-items:baseline;gap:8px}
& .logo i{font-family:var(--fl),sans-serif;font-style:normal;font-size:13px;letter-spacing:.3em;color:var(--mut);font-weight:500}
& .hero{padding:8px 16px 28px}
& .collage{position:relative;height:330px}
& .cl{position:absolute;border-radius:10px}
& .c1{width:62%;height:100%;inset-inline-start:0;top:0;z-index:1}
& .c2{width:46%;height:56%;inset-inline-end:0;top:0;z-index:2;border:3px solid #1e2340}
& .c3{width:46%;height:44%;inset-inline-end:6%;bottom:0;z-index:3;border:3px solid #1e2340}
& .hero h2{font-family:var(--fd),sans-serif;font-weight:400;font-size:46px;line-height:1.1;color:var(--ac);margin-top:20px}
& .hero p{margin-top:4px;font-size:15px}
& .band2{background:#2a3158;padding:26px 0 30px}
& .band2 h2,& .sec h2{font-family:var(--fd),sans-serif;font-weight:400;font-size:28px;padding:0 16px 14px}
& .sec{padding:28px 16px 30px}
& .sec h2{padding:0 0 14px}
& .snap{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 16px;scrollbar-width:none}
& .look{flex:0 0 78%;scroll-snap-align:start;background:#1e2340;border-radius:10px;overflow:hidden}
& .lb{padding:12px 14px 16px}
& .lb h3{font-family:var(--fd),sans-serif;font-weight:400;font-size:22px}
& .lb li{display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px solid #ffffff22}
& .btn{margin-top:12px;width:100%;min-height:44px;border:0;border-radius:999px;background:#e8a33d;color:#1e2340;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;gap:6px}
& .g2{display:grid;grid-template-columns:1fr 1fr;gap:20px 12px}
& .g2 img{border-radius:10px}
& .g2 .price{color:var(--ac)}
& .pr{display:flex;align-items:center;justify-content:space-between;margin-top:2px}
& .qa{width:40px;height:40px;border-radius:50%;border:0;background:#e8a33d;color:#1e2340;display:grid;place-items:center;padding:0}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة" data-open-menu>{I('menu')}</button>
<div class="logo">قمر <i>QAMAR</i></div><button class="ib" type="button" aria-label="السلة" data-open-cart>{I('bag')}</button></header>
<section class="hero"><div class="collage">{collage}</div><h2>لوك الأسبوع</h2><p>3 إطلالات كاملة اتصورت على سطح في وسط البلد، وتطلب كل لوك بضغطة واحدة.</p></section>
<section class="band2"><h2>اشتري اللوك كله</h2><div class="snap">{lk}</div></section>
<section class="sec"><h2>قطع بتكمّل لوكك</h2><div class="g2" data-grid>{cards}</div></section>
{footer('#12162d', '#f4f1fa', '#b9bad0', 'قمر', 'لوكات كاملة، مش قطع لوحدها.', ['اللوكات', 'المقاسات', 'الشحن والاسترجاع', 'تواصل معنا'])}"""
    return css, html


# ====================== QAMAR C · VITRINE ======================
def qc():
    BG, ROSE, TEAL, CHAMP = '#f5f5f6', '#c98b8b', '#1f4e54', '#d8b96a'
    INK = '#1a1a1d'; MUT = fix('#66666e', BG, 4.5, 'QC muted')
    ONR = on(ROSE, INK, '#fff', 'QC on rose'); ONT = on(TEAL, INK, '#fff', 'QC on teal'); ONC = on(CHAMP, INK, '#fff', 'QC on champagne')
    TXT_T = fix(TEAL, BG, 4.5, 'QC price')
    cwr = [('#f0dcdc', '#e2bcbc', ROSE, '#a56262', CHAMP), ('#d6e6e6', '#9fc0c3', TEAL, '#0f3338', CHAMP), ('#f4ead0', '#e6d29a', CHAMP, '#a8893a', TEAL)]
    hero = img('window', ('#2f3a40', '#141a1d', TEAL, '#0d2a2e', ROSE), 'فاترينة البوتيك', 1.15,
               '<circle cx="150" cy="210" r="130" fill="#d8b96a" opacity=".16"/>')
    occ = [('فرح', 'فساتين وإطلالات للعروسة والمعازيم', ROSE, ONR, 'dress', cwr[0], 'wedding'), ('خطوبة', 'ألوان هادية بتطلع حلوة في الصور', TEAL, ONT, 'dress', cwr[1], 'engagement'),
           ('سهرة', 'كعوب وكلاتش ولمعة بالليل', CHAMP, ONC, 'heels', cwr[2], 'evening')]
    oc = ''.join(f'<a class="oc" href="#" data-cat="{ck}" style="background:{b};color:{f}"><div><h3>{t}</h3><p>{d}</p></div><div class="ph oi">{img(k, cw, t, 1.2)}</div></a>' for t, d, b, f, k, cw, ck in occ)
    prods = [('فستان سهرة ساتان', 2900, None, 'dress', 0, [ROSE, TEAL, CHAMP]), ('كلاتش مطرّز', 1250, 1500, 'bag', 2, [CHAMP, '#1a1a1d']),
             ('كعب ستاتان', 1750, None, 'heels', 2, [CHAMP, ROSE]), ('فستان خطوبة دانتيل', 3400, None, 'dress', 1, [TEAL, ROSE]),
             ('بلوزة حرير', 1150, None, 'shirt', 0, [ROSE, '#f5f5f6', TEAL]), ('بنطلون سهرة', 1450, 1700, 'trousers', 1, [TEAL, '#1a1a1d'])]
    CN = {ROSE: 'وردي', TEAL: 'أخضر مزرق', CHAMP: 'شامبانيا', '#1a1a1d': 'أسود', '#f5f5f6': 'أبيض'}
    SZ = 'S|M|L|XL'
    meta = {'فستان سهرة ساتان': dict(cat='wedding evening', sizes=SZ, desc='ساتان لامع · ضهر مفتوح · بطانة حرير'),
            'كلاتش مطرّز': dict(cat='wedding engagement evening', desc='تطريز يدوي · سلسلة قابلة للفك · يشيل الموبايل والمفاتيح'),
            'كعب ستاتان': dict(cat='wedding evening', sizes='36|37|38|39|40|41', desc='كعب 8 سم · بطانة جلد · نعل مبطّن'),
            'فستان خطوبة دانتيل': dict(cat='engagement', sizes=SZ, desc='دانتيل فرنسي · بطانة ناعمة · طول ميدي'),
            'بلوزة حرير': dict(cat='engagement', sizes=SZ, desc='حرير طبيعي · أكمام واسعة'),
            'بنطلون سهرة': dict(cat='evening', sizes=SZ, desc='قماش بيقع حلو · خصر عالي · رِجل واسعة')}
    cards = ''.join(f'<article {pd(n, p, o, k, colors="|".join(f"{CN[x]}:{x}" for x in sw), **meta[n])}><div class="ph" style="aspect-ratio:3/4">{img(k, cwr[c], n)}</div><h3 class="nm" style="margin-top:8px">{n}</h3>'
                    f'<div class="sw">{"".join(f"<i style=background:{s}></i>" for s in sw)}</div>{price(p, o)}</article>' for n, p, o, k, c, sw in prods)
    css = f"""
&{{--bg:{BG};--ink:{INK};--mut:{MUT};--ac:{TXT_T};--btn:{TEAL};--btnfg:{ONT};--r:8px;--rb:999px;--ga:3/3.6;--fd:'Aref Ruqaa';--fb:'Noto Sans Arabic';--fl:'Playfair Display'}}
& .top{{display:flex;justify-content:space-between;padding:0 6px;height:48px;align-items:center}}
& .logo{{text-align:center;padding:0 0 18px}}
& .logo b{{display:block;font-family:var(--fd),serif;font-size:72px;line-height:1.05;color:{TEAL}}}
& .logo i{{font-family:var(--fl),serif;font-style:normal;font-size:13px;letter-spacing:.4em;color:{MUT}}}
& .frame{{margin:0 20px;padding:10px;outline:1px solid {CHAMP};outline-offset:-1px;border:1px solid {CHAMP}}}
& .hc{{text-align:center;padding:18px 20px 28px}}
& .hc h2{{font-size:32px}}
& .hc p{{color:{MUT};margin-top:2px}}
& .cta{{display:inline-block;margin-top:12px;padding:10px 26px;border-radius:999px;background:{TEAL};color:{ONT};font-weight:600;font-size:14px}}
& .occ{{padding:0 0 4px}}
& .occ>h2{{padding:6px 20px 14px;font-size:30px}}
& .oc{{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 20px;min-height:116px}}
& .oc h3{{font-size:34px;line-height:1.1}}
& .oc p{{font-size:13px;margin-top:4px;max-width:200px}}
& .oi{{width:92px;height:92px;border-radius:10px;flex:none}}
& .shop{{padding:34px 16px 24px}}
& .shop>h2{{font-size:30px;margin-bottom:14px}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:20px 12px}}
& .g2 img{{border-radius:8px}}
& .g2 .price{{color:var(--ac)}}
& .sw{{display:flex;gap:6px;margin:3px 0 2px}}
& .sw i{{width:16px;height:16px;border-radius:50%;border:1px solid #00000033;display:block}}
& .quote{{background:{CHAMP};color:{ONC};padding:30px 24px;text-align:center}}
& .quote p{{font-family:var(--fd),serif;font-size:24px;line-height:1.6}}
& .quote small{{display:block;font-size:13px;margin-top:8px}}
"""
    html = f"""<header><div class="top"><button class="ib" type="button" aria-label="القائمة" data-open-menu>{I('menu')}</button><button class="ib" type="button" aria-label="السلة" data-open-cart>{I('bag')}</button></div>
<div class="logo"><b>قمر</b><i>QAMAR</i></div></header>
<section><div class="frame"><div class="ph" style="aspect-ratio:4/4.6">{hero}</div></div>
<div class="hc"><h2>سهرة جاية؟ الفاترينة مفتوحة</h2><p>قطع مختارة بتنوّر مع أول ضوء في الأوضة.</p><a class="cta" href="#">شوفي الفاترينة</a></div></section>
<section class="occ"><h2>تسوّقي حسب المناسبة</h2>{oc}</section>
<section class="shop"><h2>الأكثر طلبًا</h2><div class="g2" data-grid>{cards}</div></section>
<section class="quote"><p>«لقيت فستان خطوبتي في يومين، والتوصيل وصل قبل الميعاد.»</p><small>سارة م. · مدينة نصر</small></section>
{footer(TEAL, ONT, '#d3e4e6', 'قمر', 'بوتيك مصري للمناسبات، من مصر الجديدة.', ['المناسبات', 'المقاسات', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html
