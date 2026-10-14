from lib import *

def _sub(css, **k):
    for a, b in k.items(): css = css.replace('@' + a, b)
    return css

def _chips(items, cls=''):
    return ''.join(f'<button class="chip{" on" if i == 0 else ""}" type="button">{t}</button>' for i, t in enumerate(items))

# ====================== DAHAB A · WORN ======================
def da():
    W, INK, MUT, GOLD = '#ffffff', '#121212', '#5A5A5A', '#A9792E'
    chk('A muted', MUT, W); chk('A ink', INK, W)
    G = fix(GOLD, W, 4.5, 'DA gold text')            # prices / active on white
    GD = fix(GOLD, INK, 4.5, 'DA gold on ink')        # gold text on the ink band
    cw = ('#f4f1ee', '#e6e0da', '#ffffff', '#d8d2cc', GOLD)
    prods = [('خاتم سوليتير ذهب', 'عرض 2 مم · عيار 18', 14500, 'ring'), ('سلسلة بميدالية صغيرة', 'طول 45 سم · عيار 21', 6200, 'chain'),
             ('إنسيال ذهب رفيع', 'عرض 4 مم · عيار 21', 9800, 'bracelet'), ('حلق دائري صغير', 'قطر 14 مم · عيار 21', 3500, 'ear'),
             ('طقم سلسلة وحلق', 'سلسلة 42 سم · عيار 21', 17900, 'set'), ('دلاية دائرية', 'قطر 12 مم · عيار 21', 4800, 'pendant')]
    cards = ''.join(f'<article><div class="ph" style="aspect-ratio:4/5">{img("compact", cw, n, pk=k)}</div>'
                    f'<h3 class="nm" style="margin-top:8px">{n}</h3><p class="sz">{s}</p>{price(p)}</article>' for n, s, p, k in prods)
    css = _sub("""
&{--bg:#fff;--ink:#121212;--mut:#5A5A5A;--ac:@G;--fd:'Reem Kufi';--fb:'IBM Plex Sans Arabic';--fl:'Bodoni Moda'}
& h3.nm{font-family:var(--fb),sans-serif;font-weight:600}
& .hd{display:grid;grid-template-columns:48px 1fr 48px;align-items:center;height:64px;padding:0 6px;position:sticky;top:0;background:#fff;z-index:3}
& .logo{text-align:center;line-height:1}
& .logo b{font-family:var(--fd),sans-serif;font-size:32px;font-weight:600;letter-spacing:.02em}
& .logo i{display:block;font-family:var(--fl),serif;font-style:normal;font-size:12px;letter-spacing:.42em;color:var(--mut);margin-top:3px}
& .hero{position:relative}
& .hero .cap{position:absolute;inset-inline:0;bottom:0;padding:70px 20px 22px;background:linear-gradient(to top,#000000b3,#00000000);color:#fff}
& .hero h2{font-size:32px}
& .hero p{font-size:14px;margin-top:2px}
& .cta{display:inline-block;margin-top:12px;padding:10px 22px;background:#fff;color:#121212;font-size:14px;font-weight:600}
& .chips{display:flex;gap:8px;overflow-x:auto;padding:18px 16px 14px;scrollbar-width:none}
& .chip{white-space:nowrap;padding:8px 16px;border-radius:999px;border:1px solid #cfcfcf;background:#fff;font-size:13px;min-height:40px}
& .chip.on{background:#121212;color:#fff;border-color:#121212}
& .g2{display:grid;grid-template-columns:1fr 1fr;gap:22px 4px}
& .g2 article{padding-bottom:2px}
& .g2 .nm,& .g2 .sz,& .g2 .price{padding-inline:8px;display:block}
& .sz{font-size:12px;color:var(--mut);margin:0 0 2px}
& .g2 .price{color:var(--ac)}
& .eng{margin-top:34px;background:#121212;color:#fff}
& .eng .cap{padding:24px 20px 30px}
& .eng h2{font-size:28px}
& .eng p{font-size:14px;margin-top:6px;color:#e4e4e4}
& .eng .ln{display:inline-block;margin-top:14px;font-weight:600;font-size:14px;color:@GD;border-bottom:1px solid @GD;padding-bottom:2px}
""", G=G, GD=GD)
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button>
<div class="logo"><b>دهب</b><i>DAHAB</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<section class="hero"><div class="ph" style="aspect-ratio:4/5">{img('compact', cw, 'خاتم ذهب على إيد', pk='hero')}</div>
<div class="cap"><h2>الدهب بيتشاف على الإيد</h2><p>كل قطعة متصورة لابساها، بمقاسها الحقيقي.</p><a class="cta" href="#">شوفي القطع</a></div></section>
<nav class="chips" aria-label="القطع">{_chips(['الكل', 'خواتم', 'سلاسل', 'أساور', 'حلقان', 'أطقم'])}</nav>
<section class="g2">{cards}</section>
<section class="eng"><div class="ph" style="aspect-ratio:16/10">{img('compact', cw, 'خاتم بالحفر', pk='ring2')}</div>
<div class="cap"><h2>اكتبي اسمك أو تاريخ بنفسك</h2><p>حفر بالليزر على الخاتم أو الدلاية، جاهز في يومين، من غير مصاريف زيادة لحد 12 حرف.</p><a class="ln" href="#">ابدئي التخصيص</a></div></section>
{footer('#121212', '#ffffff', '#cfcfcf', 'دهب', 'مجوهرات ذهب عيار 18 و21، من قلب جاردن سيتي.', ['من نحن', 'دليل المقاسات', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html


# ====================== DAHAB B · WORKSHOP ======================
def db():
    T, SIL, COR, W = '#0F4C4A', '#D9DDE2', '#E2674A', '#ffffff'
    INK = '#14201f'; MUT = '#4a5857'
    chk('B white on teal', W, T); chk('B silver on teal', SIL, T); chk('B ink', INK, W); chk('B mut', MUT, W)
    ONC = on(COR, INK, '#fff', 'DB on coral')
    cw = ('#0F4C4A', '#0a3836', SIL, '#9aa3ad', COR)
    prods = [('خاتم فضة بفيروز', 1450, 'تتعمل في 3 أيام', 'ring'), ('أسورة منقوشة', 2800, 'تتعمل في 5 أيام', 'cuff'),
             ('دلاية مينا زرقا', 950, 'جاهزة النهاردة', 'pendant'), ('حلق فضة متدلي', 1200, 'تتعمل في 3 أيام', 'earring')]
    cards = ''.join(f'<article><div class="ph" style="aspect-ratio:1/1">{img("compact", cw, n, pk=k)}</div><h3 class="nm" style="margin-top:8px">{n}</h3>'
                    f'<span class="lead">{t}</span><div class="pr"><span class="price">{fmt(p)}</span><button class="add" type="button" aria-label="أضيفي {n}">{I("plus", 18)}</button></div></article>' for n, p, t, k in prods)
    steps = [('رسم', 'بنرسم القطعة على الورق بمقاسك ونتفق على التفاصيل.'), ('صب', 'بنصب الفضة في القالب ونشغّلها بالإيد قطعة قطعة.'), ('تلميع', 'بنلمّع ونركّب الفيروز ونفحص كل قطعة قبل ما تتغلف.')]
    st = ''.join(f'<li><b class="num">{i + 1}</b><div><h3>{t}</h3><p>{d}</p></div></li>' for i, (t, d) in enumerate(steps))
    css = _sub("""
&{--bg:#fff;--ink:#14201f;--mut:#4a5857;--ac:#0F4C4A;--fd:'Markazi Text';--fb:'Almarai';--fl:'Libre Caslon Text'}
& h3.nm{font-family:var(--fb),sans-serif;font-weight:600}
& .hd{display:grid;grid-template-columns:48px 1fr 48px;align-items:center;height:64px;padding:0 6px;position:sticky;top:0;background:#0F4C4A;color:#fff;z-index:3;border-bottom:1px solid #D9DDE2}
& .logo{text-align:center;line-height:1}
& .logo b{font-family:var(--fd),serif;font-size:36px;font-weight:600}
& .logo i{display:block;font-family:var(--fl),serif;font-style:normal;font-size:12px;letter-spacing:.34em;color:#D9DDE2;margin-top:2px}
& .tb{background:#0F4C4A;color:#fff}
& .tb .cap{padding:22px 20px 30px}
& .tb h2{font-size:38px;line-height:1.25}
& .tb p{color:#D9DDE2;margin-top:4px;font-size:15px}
& .cta{display:inline-block;margin-top:14px;padding:11px 24px;background:#E2674A;color:@ONC;font-weight:700;font-size:14px;border-radius:4px}
& .jr{padding:32px 20px 34px}
& .jr h2{font-size:34px;margin-bottom:16px}
& .jr ol{list-style:none;margin:0;padding:0;display:grid;gap:0}
& .jr li{display:flex;gap:16px;align-items:flex-start;padding:16px 0;border-top:1px solid #D9DDE2}
& .jr li:last-child{border-bottom:1px solid #D9DDE2}
& .num{flex:none;width:44px;height:44px;border-radius:50%;background:#0F4C4A;color:#fff;display:grid;place-items:center;font-family:var(--fl),serif;font-size:20px;font-weight:400}
& .jr h3{font-size:26px}
& .jr p{font-size:14px;color:var(--mut)}
& .gr{padding:32px 16px 34px}
& .gr h2{font-size:34px;margin-bottom:14px;padding-inline:4px}
& .g2{display:grid;grid-template-columns:1fr 1fr;gap:22px 12px}
& .lead{display:inline-block;margin:4px 0 6px;padding:2px 10px;border:1px solid #D9DDE2;border-radius:999px;font-size:12px;color:#fff}
& .pr{display:flex;align-items:center;justify-content:space-between}
& .gr .price{color:#fff}
& .add{width:40px;height:40px;border-radius:50%;border:0;background:#E2674A;color:@ONC;display:grid;place-items:center;padding:0}
& .mk{display:grid;grid-template-columns:42% 1fr;gap:16px;align-items:center;padding:30px 20px 34px}
& .mk h2{font-size:30px}
& .mk p{font-size:14px;color:var(--mut);margin-top:4px}
""", ONC=ONC)
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button>
<div class="logo"><b>دهب</b><i>DAHAB · SILVER</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<section class="tb"><div class="ph" style="aspect-ratio:4/3.4">{img('compact', cw, 'إيد صايغ بتشتغل على الفضة', pk='hero')}</div>
<div class="cap"><h2>مصنوعة بإيد في الفسطاط</h2><p>فضة وفيروز بتتعمل قدامك، قطعة قطعة، من ورشة عم صلاح.</p><a class="cta" href="#">شوفي الشغل</a></div></section>
<section class="jr"><h2>رحلة القطعة</h2><ol>{st}</ol></section>
<section class="tb gr"><h2>شغل الأسبوع ده</h2><div class="g2">{cards}</div></section>
<section class="mk"><div class="ph" style="aspect-ratio:4/5;border-radius:6px">{img('compact', cw, 'عم صلاح الصايغ', pk='maker')}</div>
<div><h2>عم صلاح، صايغ من 35 سنة</h2><p>اتعلم الصنعة من أبوه في الفسطاط، ولسه بيمضي على كل قطعة بنفسه.</p></div></section>
{footer('#0F4C4A', '#ffffff', '#D9DDE2', 'دهب', 'فضة مصنوعة يدويًا من ورشة في الفسطاط.', ['من نحن', 'الورشة', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html


# ====================== DAHAB C · GIFT BOX ======================
def dc():
    EM, BL, GOLD, INK, W = '#0E5C46', '#F2C9C4', '#B88A3B', '#16201C', '#ffffff'
    chk('C ink', INK, W); chk('C white on emerald', W, EM); chk('C ink on blush', INK, BL)
    G = fix(GOLD, W, 4.5, 'DC gold text'); GB = fix(GOLD, BL, 4.5, 'DC gold on blush')
    MUT = fix('#5b6862', W, 4.5, 'DC muted'); MB = fix('#5b6862', BL, 4.5, 'DC muted on blush')
    cw = ('#fdf3f1', BL, EM, '#083d2e', GOLD)
    prods = [('حلق دهب صغير', 1650, 'earring'), ('سلسلة بقلب', 4200, 'necklace'), ('إنسيال ذهب', 3800, 'bracelet'),
             ('خاتم بفص', 7500, 'ring'), ('طقم هدية كامل', 9400, 'set'), ('دلاية ذهب مع كارت', 4900, 'necklace')]
    cards = ''.join(f'<article><div class="ph" style="aspect-ratio:1/1">{img("compact", cw, n, pk=k)}</div><h3 class="nm" style="margin-top:8px">{n}</h3>{price(p)}'
                    f'<p class="gw">{I("check", 14)} تغليف هدية</p><button class="cmp" type="button" aria-pressed="false">اكتبي كارت</button></article>' for n, p, k in prods)
    css = _sub("""
&{--bg:#fff;--ink:#16201C;--mut:@MUT;--ac:@G;--fd:'Kufam';--fb:'Tajawal';--fl:'Italiana'}
& h3.nm{font-family:var(--fb),sans-serif;font-weight:600}
& .hd{display:grid;grid-template-columns:48px 1fr 48px;align-items:center;height:64px;padding:0 6px;position:sticky;top:0;background:#fff;z-index:3;border-bottom:1px solid #F2C9C4}
& .logo{text-align:center;line-height:1}
& .logo b{font-family:var(--fd),sans-serif;font-size:30px;font-weight:600;color:#0E5C46}
& .logo i{display:block;font-family:var(--fl),serif;font-style:normal;font-size:14px;letter-spacing:.4em;color:var(--mut);margin-top:3px}
& .fd{padding:22px 16px 8px}
& .fd h2{font-size:30px;color:#0E5C46}
& .fd p{color:var(--mut);margin-top:2px;font-size:14px}
& .fd h3{font-family:var(--fb),sans-serif;font-size:13px;font-weight:700;margin:16px 0 0}
& .chips{display:flex;gap:8px;overflow-x:auto;padding:8px 0 4px;scrollbar-width:none}
& .chip{white-space:nowrap;padding:8px 16px;border-radius:999px;border:1px solid #0E5C46;background:#fff;color:#0E5C46;font-size:13px;min-height:40px;font-weight:500}
& .chip.on{background:#0E5C46;color:#fff}
& .dl{display:inline-flex;align-items:center;gap:6px;margin:14px 0 0;padding:8px 14px;border-radius:999px;background:#F2C9C4;color:#16201C;font-size:13px;font-weight:700}
& .hero{margin:18px 0 0;position:relative}
& .hero .cap{padding:16px 20px 6px}
& .hero h2{font-size:26px;color:#0E5C46}
& .hero p{font-size:14px;color:var(--mut);margin-top:2px}
& .sec{padding:26px 16px 30px}
& .g2{display:grid;grid-template-columns:1fr 1fr;gap:22px 12px}
& .g2 img,& .g2 .ph{border-radius:8px}
& .g2 .price{color:var(--ac);display:block;margin-top:2px}
& .gw{display:flex;align-items:center;gap:4px;font-size:12px;font-weight:700;color:#0E5C46;margin-top:4px}
& .cmp{margin-top:8px;min-height:40px;width:100%;border:1px solid #0E5C46;background:#fff;color:#0E5C46;border-radius:6px;font-size:13px;font-weight:700}
& .cmp[aria-pressed=true]{background:#0E5C46;color:#fff}
& .pk{background:#F2C9C4;padding:28px 16px 30px}
& .pk h2{font-size:28px;color:#0E5C46}
& .pk p{font-size:14px;margin-top:4px;color:#16201C}
& .pk .pair{display:grid;grid-template-columns:1.3fr 1fr;gap:10px;margin-top:16px}
& .pk .ph{border-radius:8px}
& .pk .ln{display:inline-block;margin-top:14px;font-weight:700;font-size:14px;color:@GBd;border-bottom:1px solid @GBd;padding-bottom:2px}
""", MUT=MUT, G=G, GBd=fix('#8a6420', BL, 4.5, 'DC link on blush'))
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button>
<div class="logo"><b>دهب</b><i>DAHAB</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<section class="fd"><h2>هدية لمين؟ وبكام؟</h2><p>اختاري المناسبة والميزانية، ونطلعلك القطع المناسبة متغلفة.</p>
<h3>المناسبة</h3><nav class="chips" aria-label="المناسبة">{_chips(['خطوبة', 'عيد ميلاد', 'عيد الأم', 'تخرج'])}</nav>
<h3>الميزانية</h3><nav class="chips" aria-label="الميزانية">{_chips(['أقل من 2,000 ج.م', 'أقل من 5,000 ج.م', 'أقل من 10,000 ج.م'])}</nav>
<span class="dl">{I('pin', 16)} اطلبي النهاردة، يوصل الخميس</span></section>
<section class="hero"><div class="ph" style="aspect-ratio:16/11">{img('compact', cw, 'فتح علبة هدية', pk='hero')}</div>
<div class="cap"><h2>لحظة الفتح بتفرّق</h2><p>علبة زمردي وشريط ساتان، جاهزة تتقدم من غير ما تتغلف تاني.</p></div></section>
<section class="sec"><div class="g2">{cards}</div></section>
<section class="pk"><h2>التغليف جزء من الهدية</h2><p>كل طلب بيوصل في علبة زمردي بشريط ساتان وكارت بخط إيدينا، من غير زيادة في السعر.</p>
<div class="pair"><div class="ph" style="aspect-ratio:1/1">{img('compact', cw, 'علب هدايا', pk='box')}</div><div class="ph" style="aspect-ratio:3/4">{img('compact', cw, 'شريط ساتان', pk='ribbon')}</div></div>
<a class="ln" href="#">شوفي أشكال التغليف</a></section>
{footer('#0E5C46', '#ffffff', '#d7ebe3', 'دهب', 'مجوهرات وهدايا متغلفة بحب.', ['من نحن', 'دليل الهدايا', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html
