from lib import *

# ====================== LAMMA A · FAMILY TABLE ======================
def la():
    TERRA, INK, HERB, W = '#b5482e', '#2a1a14', '#3e7a3a', '#ffffff'
    ONT = on(TERRA, INK, '#fff', 'LA on terracotta'); ONH = on(HERB, INK, '#fff', 'LA on herb')
    MUT = fix('#6b5a52', W, 4.5, 'LA muted'); HT = fix(HERB, W, 4.5, 'LA herb text'); TT = fix(TERRA, W, 4.5, 'LA terracotta text')
    cw = lambda c, d, a: ('#f6e3d6', '#e9c3a8', c, d, a)
    P = {'mahshi': cw('#4f8a3c', '#f2e2cc', '#b5482e'), 'tagine': cw('#b5482e', '#6b2a18', '#e9b266'), 'sweets': cw('#e0a53a', '#f2e2cc', '#8a4a1c'),
         'bowl': cw('#f4ecdc', '#b5482e', '#3e7a3a'), 'kunafa': cw('#e8a54a', '#f2e2cc', '#8a4a1c')}
    hero = img('mahshi', ('#f2cfb4', '#d98a62', '#4f8a3c', '#f6ead8', '#b5482e'), 'صينية محشي', 1.45, pk='hero', extra= '<circle cx="150" cy="170" r="120" fill="#fff" opacity=".18"/><path d="M120 110Q110 90 124 74M150 104Q140 82 154 62M180 110Q170 90 184 74" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" opacity=".7"/>')
    tabs = ''.join(f'<a class="tab{" on" if i == 0 else ""}" href="#" data-cat="{k}">{t}</a>' for i, (t, k) in enumerate([('الكل', 'all'), ('محاشي', 'mahshi'), ('طواجن', 'tagine'), ('حلويات', 'sweets'), ('أرز وجانبي', 'rice')]))
    CK = {'محشي كرنب مشكل': 'mahshi', 'محشي ورق عنب': 'mahshi', 'طاجن بامية باللحمة': 'tagine', 'طاجن عكاوي': 'tagine', 'كنافة بالقشطة': 'sweets', 'بسبوسة بالقشطة': 'sweets', 'أم علي': 'sweets', 'رز معمّر': 'rice'}
    dishes = [('محشي كرنب مشكل', 'طبق 6 قطع · يكفي 1', 185, None, 'mahshi'), ('محشي ورق عنب', 'طبق 8 قطع · يكفي 1', 195, None, 'mahshi'),
              ('طاجن بامية باللحمة', 'فرد · يكفي 1', 210, None, 'tagine'), ('طاجن عكاوي', 'فرد · يكفي 1', 245, 270, 'tagine'),
              ('كنافة بالقشطة', 'صينية صغيرة · 4 أفراد', 130, None, 'kunafa'), ('بسبوسة بالقشطة', 'قطعة · 90 جرام', 28, None, 'sweets'),
              ('أم علي', 'طبق فردي', 45, None, 'sweets'), ('رز معمّر', 'طبق وسط · يكفي 2', 95, None, 'bowl')]
    rows = ''.join(f'<article class="ds" {pd(n, p, o, k, cat=CK[n], portion=s, lead="بيتحضّر طازة · يوصلك خلال 45 دقيقة", desc="بيتطبخ الصبح في مطبخ بيتي")}><div class="ph dt">{img(k, P[k], n, 1.25)}</div><div class="db"><h3>{n}</h3><p class="sm">{s}</p>{price(p, o)}</div>'
                   f'<button class="add" type="button" aria-label="إضافة {n}" data-add>{I("plus", 22)}</button></article>' for n, s, p, o, k in dishes)
    css = f"""
&{{--bg:#fff;--ink:{INK};--mut:{MUT};--ac:{HT};--btn:{HERB};--btnfg:{ONH};--r:10px;--rb:999px;--ga:1/0.9;--fd:'El Messiri';--fb:'Cairo';--fl:'Fraunces'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;height:72px;padding:0 6px;background:{TERRA};color:{ONT};position:sticky;top:0;z-index:4}}
& .logo{{font-family:var(--fd),sans-serif;font-size:38px;font-weight:700;line-height:1;display:flex;align-items:baseline;gap:8px}}
& .logo i{{font-family:var(--fl),serif;font-style:normal;font-size:13px;letter-spacing:.28em;font-weight:600}}
& .hero{{position:relative}}
& .hero .ph{{aspect-ratio:1/1.0}}
& .time{{position:absolute;bottom:14px;inset-inline-start:16px;background:{INK};color:#fff;padding:8px 16px;border-radius:999px;font-weight:700;font-size:14px;display:flex;gap:6px;align-items:center}}
& .hc{{background:{TERRA};color:{ONT};padding:20px 20px 24px}}
& .hc h2{{font-size:30px}}
& .hc p{{margin-top:2px}}
& .tabs{{display:flex;gap:6px;overflow-x:auto;padding:0 12px;background:#fff;position:sticky;top:72px;z-index:3;border-bottom:1px solid #eadfd9;scrollbar-width:none}}
& .tab{{white-space:nowrap;padding:14px 14px 12px;font-weight:700;font-size:15px;border-bottom:3px solid transparent;color:{MUT}}}
& .tab.on{{color:{TT};border-color:{TERRA}}}
& .menu{{padding:6px 16px}}
& .ds{{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #eadfd9}}
& .dt{{width:96px;height:96px;flex:none;border-radius:10px}}
& .db{{flex:1;min-width:0}} & .db h3{{font-size:18px}}
& .db .price{{color:{INK};font-size:15px}}
& .add{{width:48px;height:48px;border-radius:50%;border:0;background:{HERB};color:{ONH};display:grid;place-items:center;padding:0;flex:none}}
& .maker{{display:flex;align-items:center;gap:14px;background:#f3ebe5;margin-top:20px;padding:20px 16px}}
& .maker .ph{{width:76px;height:76px;border-radius:50%;flex:none}}
& .maker h3{{font-size:19px}} & .maker p{{font-size:13px;color:{MUT}}}
"""
    face = img('face', ('#f2cfb4', '#d98a62', '#3a2a22', '#fff', '#b5482e'), 'أم محمود', 1.0, pk='maker')
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة" data-open-menu>{I('menu')}</button><div class="logo">لمّة <i>LAMMA</i></div><button class="ib" type="button" aria-label="السلة" data-open-cart>{I('bag')}</button></header>
<section class="hero"><div class="ph">{hero}</div><div class="time">{I('pin', 18)} التوصيل خلال 45 دقيقة</div></section>
<div class="hc"><h2>غدا الجمعة، لمّة شبرا على السفرة</h2><p>أكل بيتي بيتعمل الصبح وبيوصلك سخن.</p></div>
<nav class="tabs" aria-label="أقسام المنيو">{tabs}</nav>
<section class="menu" data-grid>{rows}</section>
<section class="maker"><div class="ph">{face}</div><div><h3>بتطبخها أم محمود من شبرا</h3><p>20 سنة طبخ للعيلة والجيران، دلوقتي بتطبخ ليك.</p></div></section>
{footer('#2a1a14', '#ffffff', '#d9c9c0', 'لمّة', 'أكل بيتي من مطابخ البيوت المصرية.', ['من نحن', 'المنيو', 'مواعيد التوصيل', 'تواصل معنا'])}"""
    return css, html


# ====================== LAMMA B · KITCHEN NOTEBOOK ======================
def lb():
    BG, BG2, TX, SAF = '#1f3d2b', '#274a34', '#f5f7f2', '#e0a526'
    MUT = fix('#b9cbbd', BG2, 4.5, 'LB muted'); ONS = on(SAF, '#1f3d2b', '#fff', 'LB on saffron'); chk('LB text', TX, BG); chk('LB saffron', SAF, BG); chk('LB saffron on bg2', SAF, BG2)
    cw = lambda c, d, a: ('#33573f', '#1b3326', c, d, a)
    P = {'bowl': cw('#f5f7f2', '#e0a526', '#c2552f'), 'mahshi': cw('#6fae55', '#f5f7f2', '#e0a526'), 'feteer': cw('#f0c872', '#a86a1c', '#f5f7f2'), 'kunafa': cw('#e8a54a', '#f5f7f2', '#8a4a1c'),
         'pickles': cw('#cfe0c8', '#e0a526', '#c2552f'), 'sweets': cw('#e0a526', '#f5f7f2', '#8a4a1c'), 'tagine': cw('#c2552f', '#7a2e18', '#e0a526')}
    face = img('face', ('#e0a526', '#b9801a', '#f5f7f2', '#fff', '#2a5a3c'), 'أم حسن', 1.0)
    sig = [('فتة الأرز باللحمة', 'الوصفة اللي جدتي كانت بتعملها كل جمعة.', 'bowl', 240), ('محشي ورق عنب', 'بلفّه واحدة واحدة بإيدي الصبح بدري.', 'mahshi', 195), ('فطير مشلتت بالعسل', 'العجين بيرتاح ليلة كاملة قبل ما يتفرد.', 'feteer', 120)]
    DAYS = '|'.join(f'{a} {b}' for a, b in [('غدًا', 'الخميس 15'), ('الجمعة', '16 أكتوبر'), ('السبت', '17 أكتوبر'), ('الأحد', '18 أكتوبر')])
    lead = 'حجز مسبق · بنطبخه يوم الاستلام'
    st = ''.join(f'<article class="sg" {pd(n, p, None, k, days=DAYS, portion="طبق للعيلة", lead=lead, desc=s)}><div class="ph" style="aspect-ratio:4/3.2">{img(k, P[k], n, 1.25)}</div><div class="sgb"><h3>{n}</h3><p>{s}</p>{price(p)}</div></article>' for n, s, k, p in sig)
    days = [('غدًا', 'الخميس 15'), ('الجمعة', '16 أكتوبر'), ('السبت', '17 أكتوبر'), ('الأحد', '18 أكتوبر')]
    cal = ''.join(f'<button class="day{" on" if i == 1 else ""}" type="button"><b>{a}</b><span>{b}</span></button>' for i, (a, b) in enumerate(days))
    prods = [('كنافة بالقشطة', 'kunafa', 130, None), ('مخلل منزلي برطمان', 'pickles', 65, 80), ('بسبوسة تقليدية', 'sweets', 95, None), ('طاجن بامية', 'tagine', 210, None), ('رز معمّر', 'bowl', 95, None), ('محشي كرنب', 'mahshi', 185, 205)]
    cards = ''.join(f'<article class="gc" {pd(n, p, o, k, days=DAYS, lead=lead, desc="بيتطبخ في مطبخ أم حسن")}><div class="ph" style="aspect-ratio:1/1">{img(k, P[k], n, 1.2)}</div><h3 class="nm">{n}</h3><div class="pr"><div>{price(p, o)}</div>'
                    f'<button class="qa" type="button" aria-label="إضافة {n}" data-add>{I("plus", 18)}</button></div></article>' for n, k, p, o in prods)
    css = f"""
&{{--bg:{BG};--ink:{TX};--mut:{MUT};--ac:{SAF};--btn:{SAF};--btnfg:{ONS};--r:10px;--rb:999px;--ga:4/3.4;--fd:'Aref Ruqaa';--fb:'Noto Naskh Arabic';--fl:'Lora'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;height:66px;padding:0 6px;position:sticky;top:0;z-index:3;background:{BG}}}
& .logo{{font-family:var(--fd),serif;font-size:36px;color:{SAF};line-height:1;display:flex;align-items:baseline;gap:8px}}
& .logo i{{font-family:var(--fl),serif;font-style:normal;font-size:13px;letter-spacing:.26em;color:{TX}}}
& .who{{display:flex;flex-direction:column;align-items:center;text-align:center;padding:12px 24px 28px}}
& .who .ph{{width:164px;height:164px;border-radius:50%;border:3px solid {SAF}}}
& .who h2{{font-size:38px;color:{SAF};margin-top:14px;line-height:1.3}}
& .who p{{font-size:16px;margin-top:4px;line-height:1.9}}
& .band{{background:{BG2};padding:26px 16px 28px}}
& .band>h2,& .sec>h2{{font-size:28px;padding-bottom:14px}}
& .sg{{margin-bottom:22px}}
& .sg .ph{{border-radius:10px}}
& .sgb{{padding-top:10px}} & .sgb h3{{font-size:24px;color:{SAF}}} & .sgb p{{font-size:15px;color:{TX};margin:2px 0 4px}}
& .sec{{padding:28px 16px 6px}}
& .days{{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}}
& .day{{border:1.5px solid {SAF};background:transparent;border-radius:10px;padding:8px 2px;min-height:60px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.4}}
& .day b{{font-size:15px}} & .day span{{font-size:12px;color:{MUT}}}
& .day.on{{background:{SAF};color:{ONS}}} & .day.on span{{color:{ONS}}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:18px 12px}}
& .gc .ph{{border-radius:10px}} & .gc .nm{{margin-top:6px;font-size:14px}}
& .gc .price{{color:{SAF}}}
& .pr{{display:flex;justify-content:space-between;align-items:center}}
& .qa{{width:40px;height:40px;border-radius:50%;border:0;background:{SAF};color:{ONS};display:grid;place-items:center;padding:0}}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة" data-open-menu>{I('menu')}</button><div class="logo">لمّة <i>LAMMA</i></div><button class="ib" type="button" aria-label="السلة" data-open-cart>{I('bag')}</button></header>
<section class="who"><div class="ph">{face}</div><h2>من مطبخ أم حسن</h2><p>25 سنة طبخ بيتي في مصر الجديدة. بطبخ الصبح، وإنت تستلم سخن وبنفس الطعم.</p></section>
<section class="band"><h2>أطباقي المشهورة</h2>{st}</section>
<section class="sec"><h2>احجز لموعد قادم</h2><div class="days">{cal}</div></section>
<section class="sec" style="padding-bottom:30px"><h2>باقي المطبخ</h2><div class="g2" data-grid>{cards}</div></section>
{footer('#16301f', '#f5f7f2', '#b9cbbd', 'لمّة', 'من مطبخ أم حسن لحد بيتك.', ['من نحن', 'المنيو', 'مواعيد الحجز', 'تواصل معنا'])}"""
    return css, html


# ====================== LAMMA C · FRESH MARKET ======================
def lc():
    W, INK = '#ffffff', '#1b1b1f'
    TOM, HERB, SAF, AUB = '#e2412b', '#2e8b57', '#f2b632', '#5b2a6e'
    MUT = fix('#5d5d66', W, 4.5, 'LC muted')
    TOM = fix(TOM, W, 4.5, 'LC tomato fill (white label)'); HERB = fix(HERB, W, 4.5, 'LC herb fill (white label)')
    ONT = on(TOM, INK, '#fff', 'LC on tomato'); ONH = on(HERB, INK, '#fff', 'LC on herb'); ONS = on(SAF, INK, '#fff', 'LC on saffron'); ONA = on(AUB, INK, '#fff', 'LC on aubergine')
    HT = fix(HERB, W, 4.5, 'LC herb text'); TT = fix(TOM, W, 4.5, 'LC tomato text')
    cats = [('خضار', TOM, ONT, 'tomatoes', ('#7ac26a', '#fff')), ('ورقيات', HERB, ONH, 'herbs', ('#c8f0c0', '#fff')), ('فواكه', SAF, ONS, 'fruit', ('#e2412b', '#2e8b57')),
            ('ألبان وبيض', AUB, ONA, 'crate', ('#f2b632', '#fff')), ('مخبوزات', SAF, ONS, 'feteer', ('#b5482e', '#fff')), ('مخللات', HERB, ONH, 'pickles', ('#f4ecdc', '#f2b632')),
            ('أرز وبقوليات', TOM, ONT, 'bowl', ('#f2b632', '#fff')), ('حلويات', AUB, ONA, 'sweets', ('#f2b632', '#fff'))]
    CK = {'tomatoes': 'veg', 'herbs': 'herbs', 'fruit': 'fruit', 'crate': 'dairy', 'feteer': 'bakery', 'pickles': 'pickles', 'bowl': 'grains', 'sweets': 'sweets'}
    PC = {'طماطم بلدي': 'veg', 'بيض أبيض': 'dairy', 'برتقال بلدي': 'fruit', 'بقدونس': 'herbs', 'عيش بلدي': 'bakery', 'لبن كامل الدسم': 'dairy', 'جبنة رومي': 'dairy', 'أرز مصري': 'grains'}
    tiles = ''
    for n, bg, fg, k, cc in cats:
        c, d = cc
        colors = {'tomatoes': ('#ffffff', '#2e8b57', '#fff'), 'herbs': ('#c8f0c0', '#ffffff', '#f2b632'), 'fruit': ('#e2412b', '#2e8b57', '#f2b632'),
                  'crate': ('#f2e6f7', '#f2b632', '#ffffff'), 'feteer': ('#fff2cf', '#b5482e', '#f2b632'), 'pickles': ('#f4ecdc', '#f2b632', '#2e8b57'),
                  'bowl': ('#fff', '#f2b632', '#2e8b57'), 'sweets': ('#f2b632', '#fff', '#5b2a6e')}[k]
        tiles += f'<a class="tl" href="#" data-cat="{CK[k]}" style="background:{bg};color:{fg}"><div class="ph">{img(k, (bg, bg, colors[0], colors[1], colors[2]), n, 1.2)}</div><span>{n}</span></a>'
    wh = ('#ffffff', '#ffffff')
    prods = [('طماطم بلدي', 'كيلو', 18, 24, 'tomatoes', ('#e2412b', '#2e8b57', '#2e8b57')), ('بيض أبيض', '30 بيضة', 135, 150, 'crate', ('#f2b632', '#5b2a6e', '#fff')),
             ('برتقال بلدي', 'كيلو', 28, None, 'fruit', ('#f2b632', '#2e8b57', '#e2412b')), ('بقدونس', 'ربطة', 8, None, 'herbs', ('#2e8b57', '#5b2a6e', '#f2b632')),
             ('عيش بلدي', '10 أرغفة', 12, None, 'feteer', ('#d99a3a', '#5b2a6e', '#f2b632')), ('لبن كامل الدسم', 'لتر', 52, None, 'pickles', ('#ffffff', '#2e8b57', '#e2412b')),
             ('جبنة رومي', '250 جرام', 85, 95, 'sweets', ('#f2b632', '#5b2a6e', '#fff')), ('أرز مصري', 'كيس 1 كيلو', 38, None, 'bowl', ('#fff', '#f2b632', '#2e8b57'))]
    def pc(n, u, p, o, k, c, deal=False):
        return (f'<article class="pc" {pd(n, p, o, k, cat=PC[n], unit=u, desc="طازة من السوق الصبح · بنوصّلها في ساعة")}><div class="ph" style="aspect-ratio:1/1;background:#f6f6f7">{img(k, ("#f6f6f7", "#f6f6f7") + c, n, 1.1)}</div>' + ('<span class="off">عرض</span>' if o else '') +
                f'<h3 class="nm">{n}</h3><p class="sm">{u}</p><div class="pr"><div>{price(p, o)}</div><div class="step"><button type="button" aria-label="إضافة {n}" data-add>{I("plus", 16)}</button></div></div></article>')
    reorder = ''.join(f'<article class="ro" {pd(n, p, o, k, cat=PC[n], unit=u, desc="طازة من السوق الصبح · بنوصّلها في ساعة")}><div class="ph" style="aspect-ratio:1/1;background:#f6f6f7">{img(k, ("#f6f6f7", "#f6f6f7") + c, n, 1.1)}</div><h3 class="nm">{n}</h3><button class="again" type="button" data-add>اطلب تاني</button></article>' for n, u, p, o, k, c in prods[:4])
    deals = ''.join(f'<div class="ro">{pc(*x)}</div>' for x in [prods[1], prods[0], prods[6], prods[3]])
    grid = ''.join(pc(*x) for x in prods)
    css = f"""
&{{--bg:#fff;--ink:{INK};--mut:{MUT};--ac:{HT};--btn:{HERB};--btnfg:{ONH};--r:12px;--rb:999px;--ga:1/1;--fd:'Baloo Bhaijaan 2';--fb:'Almarai';--fl:'Nunito'}}
& .hd{{padding:6px 6px 8px;position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #eee}}
& .hr{{display:flex;align-items:center;justify-content:space-between}}
& .logo{{font-family:var(--fd),sans-serif;font-size:36px;font-weight:700;line-height:1;color:{TT};display:flex;align-items:baseline;gap:8px}}
& .logo i{{font-family:var(--fl),sans-serif;font-style:normal;font-size:13px;letter-spacing:.24em;color:{INK};font-weight:700}}
& .loc{{display:flex;align-items:center;gap:6px;padding:0 10px;font-size:13px;color:{MUT}}}
& .tiles{{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:14px 12px 6px}}
& .tl{{border-radius:12px;text-align:center;padding:6px 4px 8px;font-weight:700;font-size:13px;line-height:1.3}}
& .tl .ph{{aspect-ratio:1/1;border-radius:8px;margin-bottom:2px;background:transparent}}
& .sec{{padding:22px 0 4px}}
& .sec>h2{{padding:0 12px 10px;font-size:23px}}
& .row{{padding:0 12px}}
& .ro{{flex:none;width:168px}}
& .ro .ph{{border-radius:12px}}
& .again{{width:100%;margin-top:4px;min-height:40px;border-radius:999px;border:2px solid {HERB};background:#fff;color:{HT};font-weight:700;font-size:13px}}
& .off{{position:absolute;top:0;inset-inline-start:0;margin:8px;background:{TOM};color:{ONT};font-size:12px;font-weight:700;padding:1px 10px;border-radius:999px}}
& .pc{{position:relative}} & .pc .ph{{border-radius:12px}}
& .pc .nm{{margin-top:4px;font-weight:700}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:16px 10px;padding:0 12px 130px}}
& .pr{{display:flex;justify-content:space-between;align-items:center;gap:4px}}
& .pr .price{{font-size:15px}}
& .step button{{width:40px;height:40px;border-radius:50%;border:0;background:{HERB};color:{ONH};display:grid;place-items:center;padding:0}}
& .cart{{position:sticky;bottom:0;z-index:4;margin:0;padding:10px 12px;background:{AUB};color:{ONA};display:flex;justify-content:space-between;align-items:center}}
& .cart b{{font-size:16px}} & .cart span{{font-size:13px}}
& .cart button{{background:{SAF};color:{ONS};padding:10px 22px;border:0;border-radius:999px;font-weight:800;font-size:14px;min-height:44px}}
"""
    html = f"""<header class="hd"><div class="hr"><button class="ib" type="button" aria-label="القائمة" data-open-menu>{I('menu')}</button><div class="logo">لمّة <i>LAMMA</i></div><button class="ib" type="button" aria-label="السلة" data-open-cart>{I('bag')}</button></div>
<div class="loc">{I('pin', 16)} التوصيل إلى: المعادي، دار السلام</div></header>
<nav class="tiles" aria-label="الأقسام">{tiles}</nav>
<section class="sec"><h2>اطلب تاني</h2><div class="row">{reorder}</div></section>
<section class="sec"><h2>عروض الصبح</h2><div class="row">{deals}</div></section>
<section class="sec" style="padding-top:26px"><h2>كل حاجة للبيت</h2><div class="g2" data-grid>{grid}</div></section>
{footer('#1b1b1f', '#ffffff', '#c7c7cf', 'لمّة', 'خضار وبقالة وأكل بيتي، لحد باب بيتك.', ['من نحن', 'مواعيد التوصيل', 'الشحن والاسترجاع', 'تواصل معنا'])}
<div class="cart"><div><b data-cart-total>0 ج.م</b><br><span data-cart-label>السلة فاضية</span></div><button type="button" data-open-cart>كمّل الطلب</button></div>"""
    return css, html
