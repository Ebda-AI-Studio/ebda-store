from lib import *

# ====================== JASMINE A · APOTHECARY ======================
def ja():
    BG, BG2, TX, AM = '#2e2a22', '#3a352b', '#f3efe6', '#c9822b'
    MUT = fix('#cfc7b6', BG, 4.5, 'JA muted'); AMT = fix(AM, BG, 4.5, 'JA amber text'); ONA = on(AM, '#2e2a22', '#fff', 'JA on amber')
    chk('JA text', TX, BG)
    cw = lambda c, d, a: ('#463f31', '#2a261f', c, d, a)
    AMB = cw('#b9741f', '#f3efe6', '#e9b266')
    P = {'dropper': AMB, 'jar': cw('#d8cdb4', '#6e4a1c', '#c9822b'), 'pump': cw('#8a5b22', '#f3efe6', '#f0cf94'), 'tube': cw('#e9dcc0', '#6e4a1c', '#c9822b'), 'compact': cw('#c9822b', '#2e2a22', '#f3efe6'), 'mask': cw('#d8cdb4', '#6e4a1c', '#c9822b')}
    hero = img('dropper', ('#4a4130', '#231f18', '#b9741f', '#f3efe6', '#e9b266'), 'قارورة سيروم كهرمانية', 1.5, pk='hero')
    ings = ['زيت حبة البركة', 'عسل سدر', 'ماء ورد بلدي', 'زبدة الشيا', 'فيتامين E']
    il = ''.join(f'<li><span class="dot"></span>{t}</li>' for t in ings)
    chips = ''.join(f'<button class="chip{" on" if i == 0 else ""}" type="button">{t}</button>' for i, t in enumerate(['كل البشرات', 'جافة', 'دهنية', 'مختلطة', 'حساسة']))
    prods = [('سيروم حبة البركة والعسل', 'حبة البركة · عسل سدر · فيتامين E', 420, 495, 'dropper'), ('كريم الشيا المرطب', 'زبدة الشيا · زيت اللوز · جلسرين', 380, None, 'jar'),
             ('زيت الأرجان الصافي', 'أرجان 100% معصور على البارد', 295, None, 'dropper'), ('ماء ورد بلدي', 'ورد جوري مقطّر · بدون كحول', 120, None, 'pump'),
             ('مقشر العسل والشوفان', 'شوفان · عسل · حمض اللاكتيك', 260, 310, 'tube'), ('بلسم الشفايف بالعسل', 'شمع نحل · عسل · زيت جوجوبا', 85, None, 'compact'),
             ('ماسك الطين الأخضر', 'طين أخضر · زيت شجرة الشاي', 190, None, 'mask'), ('زيت جوز الهند للجسم', 'جوز هند بكر · فانيليا طبيعية', 210, None, 'jar')]
    rows = ''.join(f'<article class="rw"><div class="ph rt">{img(k, P[k], n, 1.2)}</div><div class="rb"><h3>{n}</h3><p class="ing">{i}</p>{price(p, o)}</div>'
                   f'<button class="qa" type="button" aria-label="إضافة {n}">{I("plus", 18)}</button></article>' for n, i, p, o, k in prods)
    css = f"""
&{{--bg:{BG};--ink:{TX};--mut:{MUT};--ac:{AMT};--fd:'Amiri';--fb:'Noto Sans Arabic';--fl:'Fraunces'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;height:70px;padding:0 6px;position:sticky;top:0;z-index:3;background:{BG}}}
& .logo{{text-align:center;line-height:1}}
& .logo b{{display:block;font-family:var(--fd),serif;font-size:38px;color:{AMT}}}
& .logo i{{font-family:var(--fl),serif;font-style:normal;font-size:13px;letter-spacing:.3em;color:{MUT}}}
& .hero{{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:10px 16px 26px;align-items:center}}
& .hero .ph{{aspect-ratio:3/4.2;border-radius:10px}}
& .hero h2{{font-size:32px}}
& .hero ul{{margin:10px 0 14px}}
& .hero li{{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #ffffff1f;font-size:14px}}
& .dot{{width:7px;height:7px;border-radius:50%;background:{AM};flex:none}}
& .cta{{display:inline-block;padding:10px 20px;background:{AM};color:{ONA};font-weight:700;border-radius:8px;font-size:14px}}
& .skin{{padding:6px 0 4px}}
& .skin>h2{{font-size:26px;padding:0 16px 10px}}
& .chips{{display:flex;gap:8px;overflow-x:auto;padding:0 16px 16px;scrollbar-width:none}}
& .chip{{white-space:nowrap;padding:8px 16px;border-radius:999px;border:1px solid #8a8168;background:transparent;font-size:13px;min-height:40px}}
& .chip.on{{background:{TX};color:{BG};border-color:{TX}}}
& .rows{{padding:0 16px 8px}}
& .rw{{display:flex;gap:12px;align-items:center;padding:12px 0;border-top:1px solid #ffffff1f}}
& .rt{{width:88px;height:104px;flex:none;border-radius:8px}}
& .rb{{flex:1;min-width:0}}
& .rb h3{{font-size:19px}}
& .ing{{font-size:13px;color:{MUT};margin:0 0 4px}}
& .rb .price{{color:{AMT}}}
& .qa{{width:44px;height:44px;border-radius:50%;border:0;background:{AM};color:{ONA};display:grid;place-items:center;padding:0;flex:none}}
& .ritual{{margin-top:22px;background:{AM};color:{ONA};padding:30px 22px}}
& .ritual h2{{font-size:30px;line-height:1.3}}
& .ritual p{{margin-top:8px;font-size:15px}}
& .ritual a{{display:inline-block;margin-top:14px;padding:10px 22px;border:2px solid {ONA};border-radius:8px;font-weight:700;font-size:14px}}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button><div class="logo"><b>ياسمين</b><i>JASMINE</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<section class="hero"><div><h2>اللي جوّه الازازة أهم من برّاها</h2><ul>{il}</ul><a class="cta" href="#">شوف السيروم</a></div><div class="ph">{hero}</div></section>
<section class="skin"><h2>حسب نوع بشرتك</h2><nav class="chips" aria-label="نوع البشرة">{chips}</nav></section>
<section class="rows">{rows}</section>
<section class="ritual"><h2>طقس المسا: ننضّف، نغذّي، ونقفل بالزيت</h2><p>تحضيرات بالمكونات الطبيعية زي ما كانت صيدليات إسكندرية بتعمل زمان، من غير عطور صناعية.</p><a href="#">اقرأ الحكاية</a></section>
{footer('#231f18', '#f3efe6', '#d1c9b8', 'ياسمين', 'عناية بالبشرة بمكونات طبيعية وواضحة.', ['من نحن', 'المكونات', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html


# ====================== JASMINE B · BLOOM ======================
def jb():
    BG, INK, RB = '#f6d7dc', '#3a1e2a', '#c2185b'
    MUT = fix('#6b4553', BG, 4.5, 'JB muted'); RBT = fix(RB, BG, 4.5, 'JB raspberry text'); ONR = on(RB, INK, '#fff', 'JB on raspberry')
    chk('JB ink', INK, BG)
    cw = lambda c, d, a, b1='#fbe8ec', b2='#f0b9c5': (b1, b2, c, d, a)
    P = {'tube': cw('#c2185b', '#fff', '#f48fb1'), 'compact': cw('#f48fb1', '#c2185b', '#ffe0e8'), 'pump': cw('#fff', '#c2185b', '#f8bbd0'), 'mask': cw('#fff', '#c2185b', '#f48fb1'),
         'lipstick': cw('#c2185b', '#3a1e2a', '#e57399'), 'jar': cw('#fff', '#f48fb1', '#c2185b'), 'dropper': cw('#fce4ec', '#c2185b', '#f06292')}
    hero = img('lipstick', ('#f9c6d0', '#e88aa0', '#c2185b', '#3a1e2a', '#e57399'), 'تينت شفايف', 1.55, '<circle cx="220" cy="110" r="70" fill="#fff" opacity=".35"/>', pk='hero')
    steps = [('الصبح', 'غسول لطيف', 'pump', 'ابدئي يومك بغسول لطيف يصحّي بشرتك'), ('الصبح', 'مرطب خفيف', 'jar', 'ترطيب من غير لمعة'), ('المسا', 'سيروم ليلي', 'dropper', 'يشتغل وإنتي نايمة'), ('المسا', 'ماسك أسبوعي', 'mask', 'ليلة سبا لوحدك')]
    rc = ''.join(f'<article class="rtn"><div class="ph" style="aspect-ratio:1/1">{img(k, P[k], n, 1.15)}</div><b>{s}</b><h3>{n}</h3><p>{d}</p></article>' for s, n, k, d in steps)
    shades = ['#c2185b', '#e57399', '#a8323e', '#d98a6c', '#7a2e3d']
    prods = [('تينت شفايف', 'lipstick', 175, None, shades), ('بلاشر كريمي', 'compact', 240, 290, ['#f48fb1', '#e57399', '#d98a6c']), ('كريم مرطب بالورد', 'jar', 320, None, []),
             ('ماسك الشيت', 'mask', 55, None, []), ('غسول الوجه', 'pump', 210, None, []), ('كونسيلر ناعم', 'tube', 195, 230, ['#f3cdb4', '#e6b393', '#c98e6b', '#9a6445'])]
    cards = ''.join(f'<article><div class="ph" style="aspect-ratio:1/1.1">{img(k, P[k], n, 1.2)}</div><h3 class="nm">{n}</h3>'
                    + (f'<div class="sw">{"".join(f"<i style=background:{c}></i>" for c in sh)}</div>' if sh else '<div class="sw" style="height:16px"></div>')
                    + f'<div class="pr">{price(p, o)}<button class="qa" type="button" aria-label="إضافة {n}">{I("plus", 18)}</button></div></article>' for n, k, p, o, sh in prods)
    ug = ''.join(f'<div class="ph u">{img("face", ("#fbe8ec", "#f0b9c5", c, "#fff", a), "صورة عميلة", 1.0, pk=f"face{i}")}</div>' for i, (c, a) in enumerate([('#c2185b', '#f48fb1'), ('#3a1e2a', '#c2185b'), ('#e57399', '#fff'), ('#7a2e3d', '#f06292'), ('#c2185b', '#fff')]))
    css = f"""
&{{--bg:{BG};--ink:{INK};--mut:{MUT};--ac:{RBT};--fd:'Rubik';--fb:'Tajawal';--fl:'DM Sans'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;height:68px;padding:0 6px;position:sticky;top:0;z-index:3;background:{BG}}}
& .logo{{font-family:var(--fd),sans-serif;font-size:36px;font-weight:700;color:{RBT};display:flex;align-items:baseline;gap:8px;line-height:1}}
& .logo i{{font-family:var(--fl),sans-serif;font-style:normal;font-size:13px;letter-spacing:.24em;color:{INK};font-weight:500}}
& .hero{{padding:6px 16px 22px}}
& .hero .ph{{aspect-ratio:4/4.4;border-radius:12px}}
& .hero h2{{font-size:32px;margin-top:16px}}
& .hero p{{margin-top:2px;color:{MUT}}}
& .cta{{display:inline-block;margin-top:12px;padding:12px 28px;border-radius:999px;background:{RB};color:{ONR};font-weight:700;font-size:14px}}
& .sec{{padding:14px 0 10px}}
& .sec>h2{{font-size:26px;padding:0 16px 12px}}
& .snap{{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 16px;scrollbar-width:none}}
& .rtn{{flex:0 0 62%;scroll-snap-align:start;background:#fff1f3;border-radius:12px;padding:10px 10px 16px}}
& .rtn .ph{{border-radius:8px;margin-bottom:8px}}
& .rtn b{{font-size:13px;color:{RBT}}}
& .rtn h3{{font-size:19px}} & .rtn p{{font-size:13px;color:{MUT}}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:20px 12px;padding:0 16px}}
& .g2 .ph{{border-radius:12px}}
& .g2 .nm{{margin-top:6px}}
& .sw{{display:flex;gap:6px;margin:2px 0 3px}}
& .sw i{{width:16px;height:16px;border-radius:50%;display:block;border:2px solid #fff}}
& .pr{{display:flex;justify-content:space-between;align-items:center}}
& .pr .price{{color:{RBT}}}
& .qa{{width:40px;height:40px;border-radius:50%;border:0;background:{RB};color:{ONR};display:grid;place-items:center;padding:0}}
& .ugc{{padding:30px 0 34px}}
& .ugc>h2{{font-size:24px;padding:0 16px 12px}}
& .u{{flex:none;width:112px;height:112px;border-radius:12px}}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button><div class="logo">ياسمين <i>JASMINE</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<section class="hero"><div class="ph">{hero}</div><h2>لون الشفايف هو لون الصفحة</h2><p>درجات بتلبّس كل بشرة مصرية، من الفاتح للقمحي.</p><a class="cta" href="#">جرّبي الدرجات</a></section>
<section class="sec"><h2>روتينك اليومي</h2><div class="snap">{rc}</div></section>
<section class="sec" style="padding-top:26px"><h2>أحدث المنتجات</h2><div class="g2">{cards}</div></section>
<section class="ugc"><h2>بنات ياسمين بيجرّبوا</h2><div class="row">{ug}</div></section>
{footer('#3a1e2a', '#fff1f3', '#e9c3cd', 'ياسمين', 'ألوان وعناية في مكان واحد.', ['من نحن', 'درجات الألوان', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html


# ====================== JASMINE C · CLINIC ======================
def jc():
    W, INK, MINT, AQ = '#ffffff', '#13212b', '#2fa88f', '#e6f5f2'
    MUT = fix('#4f6070', AQ, 4.5, 'JC muted'); MT = fix(MINT, W, 4.5, 'JC mint text'); ONM = on(MINT, INK, '#fff', 'JC on mint')
    chk('JC ink', INK, W); chk('JC ink on aqua', INK, AQ)
    cw = lambda c, d, a: ('#f1f8f7', '#dcefec', c, d, a)
    P = {'pump': cw('#ffffff', MINT, '#cfeee8'), 'dropper': cw('#e6f5f2', INK, MINT), 'tube': cw('#ffffff', MINT, '#d5efe9'), 'jar': cw('#ffffff', INK, MINT), 'mask': cw('#ffffff', MINT, '#cfeee8')}
    hero = img('pump', ('#eaf6f4', '#c3e5df', '#ffffff', MINT, '#cfeee8'), 'عبوة غسول', 1.45, pk='hero')
    steps = [('1', 'نضّفي', 'غسول لطيف بالساليسيليك 1%', 'pump', 180), ('2', 'عالجي', 'سيروم نياسيناميد 10%', 'dropper', 340), ('3', 'احمي', 'واقي شمس SPF 50+', 'tube', 290)]
    st = ''.join(f'<li class="st"><span class="n">{n}</span><div class="ph sh">{img(k, P[k], t, 1.2)}</div><div class="sb"><h3>{t}</h3><p>{d}</p>{price(p)}</div><button class="qa" type="button" aria-label="إضافة {t}">{I("plus", 18)}</button></li>' for n, t, d, k, p in steps)
    cons = [('حب الشباب', 'تنظيف المسام وتهدئة الالتهاب'), ('تصبغات', 'توحيد اللون وإضاءة تدريجية'), ('جفاف', 'ترطيب عميق وحماية الحاجز')]
    ct = ''.join(f'<a class="cn" href="#"><h3>{t}</h3><p>{d}</p></a>' for t, d in cons)
    prods = [('سيروم نياسيناميد', 'نياسيناميد 10%', 340, 395, 'dropper'), ('غسول ساليسيليك', 'ساليسيليك 1%', 180, None, 'pump'), ('كريم سيراميد', 'سيراميد 3%', 365, None, 'jar'),
             ('واقي شمس SPF 50+', 'فلاتر معدنية', 290, 330, 'tube'), ('سيروم فيتامين C', 'فيتامين C 15%', 410, None, 'dropper'), ('ماسك مرطّب', 'هيالورونيك 2%', 60, None, 'mask')]
    cards = ''.join(f'<article><div class="ph" style="aspect-ratio:1/1.1">{img(k, P[k], n, 1.15)}</div><span class="act">{a}</span><h3 class="nm">{n}</h3>'
                    f'<div class="pr">{price(p, o)}<button class="qa" type="button" aria-label="إضافة {n}">{I("plus", 18)}</button></div></article>' for n, a, p, o, k in prods)
    css = f"""
&{{--bg:#fff;--ink:{INK};--mut:{MUT};--ac:{MT};--fd:'Readex Pro';--fb:'Readex Pro';--fl:'Figtree'}}
& .hd{{display:flex;align-items:center;justify-content:space-between;height:66px;padding:0 6px;position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #e2eceb}}
& .logo{{font-size:30px;font-weight:600;display:flex;align-items:baseline;gap:8px;line-height:1}}
& .logo i{{font-family:var(--fl),sans-serif;font-style:normal;font-size:13px;letter-spacing:.26em;color:{MUT};font-weight:500}}
& .hero{{background:{AQ};display:grid;grid-template-columns:1.1fr 1fr;align-items:center;gap:6px;padding:18px 16px}}
& .hero .ph{{aspect-ratio:3/4;border-radius:10px}}
& .hero h2{{font-size:25px;line-height:1.5}}
& .hero p{{color:{MUT};font-size:13px;margin:6px 0 12px}}
& .cta{{display:inline-block;padding:10px 20px;background:{MINT};color:{ONM};font-weight:600;border-radius:8px;font-size:14px}}
& .rt{{padding:30px 16px 10px}}
& .rt>h2{{font-size:25px;margin-bottom:12px}}
& .st{{display:flex;align-items:center;gap:10px;padding:12px 0;border-top:1px solid #e2eceb;position:relative}}
& .n{{width:32px;height:32px;border-radius:50%;background:{MINT};color:{ONM};font-weight:700;display:grid;place-items:center;flex:none;font-size:15px}}
& .sh{{width:72px;height:84px;flex:none;border-radius:8px}}
& .sb{{flex:1;min-width:0}} & .sb h3{{font-size:17px}} & .sb p{{font-size:13px;color:{MUT};margin:0 0 2px}}
& .qa{{width:40px;height:40px;border-radius:50%;border:1.5px solid {INK};background:#fff;display:grid;place-items:center;padding:0;flex:none}}
& .cons{{padding:22px 16px 6px;background:#fff}}
& .cons>h2{{font-size:25px;margin-bottom:12px}}
& .cn{{display:block;background:{AQ};border-radius:10px;padding:14px 16px;margin-bottom:8px}}
& .cn h3{{font-size:18px}} & .cn p{{font-size:13px;color:{MUT}}}
& .shop{{padding:24px 16px 30px}}
& .shop>h2{{font-size:25px;margin-bottom:12px}}
& .g2{{display:grid;grid-template-columns:1fr 1fr;gap:20px 12px}}
& .g2 .ph{{border-radius:10px}}
& .act{{display:inline-block;margin-top:6px;background:{AQ};color:{INK};font-size:12px;font-weight:600;padding:1px 10px;border-radius:999px}}
& .pr{{display:flex;justify-content:space-between;align-items:center}}
"""
    html = f"""<header class="hd"><button class="ib" type="button" aria-label="القائمة">{I('menu')}</button><div class="logo">ياسمين <i>JASMINE</i></div><button class="ib" type="button" aria-label="السلة">{I('bag')}</button></header>
<section class="hero"><div><h2>بشرة هادية بخطوات واضحة</h2><p>روتين معتمد على مكونات فعّالة بتركيزات مكتوبة.</p><a class="cta" href="#">ابدئي روتينك</a></div><div class="ph">{hero}</div></section>
<section class="rt"><h2>روتينك في 3 خطوات</h2><ol style="list-style:none;margin:0;padding:0">{st}</ol></section>
<section class="cons"><h2>إيه اللي مضايق بشرتك؟</h2>{ct}</section>
<section class="shop"><h2>كل المنتجات</h2><div class="g2">{cards}</div></section>
{footer('#13212b', '#ffffff', '#bfd0d8', 'ياسمين', 'عناية جلدية بمعايير واضحة، بإشراف صيدلانية.', ['من نحن', 'المكونات', 'الشحن والاسترجاع', 'تواصلي معنا'])}"""
    return css, html
