"""Palette-matched SVG illustrations (fallback: Gemini image quota is 0 on this key).
Every art() returns a base64 data: URI. Objects sit inside x 40-260 / y 80-320 so any crop keeps them."""
import base64

def _uri(inner, bg1, bg2):
    s = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice">'
         '<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="%s"/>'
         '<stop offset="1" stop-color="%s"/></linearGradient></defs><rect width="300" height="400" fill="url(#g)"/>%s</svg>'
         % (bg1, bg2, inner))
    return "data:image/svg+xml;base64," + base64.b64encode(s.encode()).decode()

def shade(): return '<ellipse cx="150" cy="312" rx="78" ry="9" fill="#000" opacity=".16"/>'

def o_shirt(c, d, a):
    return (f'<path d="M95 120L130 104Q150 126 170 104L205 120L248 168L222 190L205 172V292H95V172L78 190L52 168Z" fill="{c}"/>'
            f'<path d="M130 104Q150 126 170 104" fill="none" stroke="{d}" stroke-width="4"/><path d="M150 126V292" stroke="{d}" stroke-width="2" opacity=".5"/>'
            f'<circle cx="150" cy="170" r="3" fill="{a}"/><circle cx="150" cy="208" r="3" fill="{a}"/><circle cx="150" cy="246" r="3" fill="{a}"/>')
def o_dress(c, d, a):
    return (f'<path d="M122 96H178L190 152L174 172L218 304H82L126 172L110 152Z" fill="{c}"/>'
            f'<path d="M126 172L174 172L172 186L128 186Z" fill="{a}"/><path d="M122 96Q150 126 178 96" fill="none" stroke="{d}" stroke-width="3"/>'
            f'<path d="M150 186L150 304" stroke="{d}" stroke-width="2" opacity=".35"/>')
def o_trousers(c, d, a):
    return (f'<path d="M104 108H196L208 304H160L150 176L140 304H92Z" fill="{c}"/><rect x="104" y="108" width="92" height="14" fill="{d}"/>'
            f'<path d="M150 122V176" stroke="{d}" stroke-width="2"/><circle cx="150" cy="115" r="3" fill="{a}"/>')
def o_coat(c, d, a):
    return (f'<path d="M104 98H196L220 150L230 312H70L80 150Z" fill="{c}"/><path d="M150 98V312" stroke="{d}" stroke-width="3"/>'
            f'<path d="M104 98Q150 138 196 98" fill="none" stroke="{d}" stroke-width="4"/><circle cx="138" cy="170" r="4" fill="{a}"/><circle cx="138" cy="210" r="4" fill="{a}"/><circle cx="138" cy="250" r="4" fill="{a}"/>')
def o_bag(c, d, a):
    return (f'<path d="M112 176Q112 108 150 108Q188 108 188 176" fill="none" stroke="{d}" stroke-width="9"/>'
            f'<rect x="82" y="168" width="136" height="124" rx="10" fill="{c}"/><rect x="82" y="168" width="136" height="38" rx="10" fill="{d}" opacity=".35"/>'
            f'<circle cx="150" cy="212" r="9" fill="{a}"/>')
def o_heels(c, d, a):
    return (f'<path d="M72 262Q120 266 190 222L206 184L228 196L216 252L206 296H194L190 266Q130 290 72 284Z" fill="{c}"/>'
            f'<path d="M206 184L228 196" stroke="{a}" stroke-width="5"/><rect x="194" y="262" width="12" height="38" fill="{d}"/>')
def o_sneaker(c, d, a):
    return (f'<path d="M62 252Q60 198 108 198L134 214Q180 206 222 238L242 252Q248 278 230 282H76Q62 280 62 252Z" fill="{c}"/>'
            f'<rect x="60" y="272" width="186" height="16" rx="8" fill="{d}"/><path d="M118 214L130 232M134 214L146 232M150 214L162 232" stroke="{a}" stroke-width="3"/>')
def o_phone(c, d, a):
    return (f'<rect x="102" y="88" width="96" height="206" rx="14" fill="{c}"/><rect x="110" y="98" width="80" height="184" rx="8" fill="{d}"/>'
            f'<rect x="124" y="120" width="52" height="52" rx="12" fill="{a}" opacity=".9"/><rect x="118" y="190" width="64" height="8" rx="4" fill="{a}" opacity=".5"/><rect x="118" y="206" width="44" height="8" rx="4" fill="{a}" opacity=".35"/>')
def o_laptop(c, d, a):
    return (f'<rect x="72" y="118" width="156" height="108" rx="7" fill="{c}"/><rect x="80" y="126" width="140" height="92" rx="3" fill="{d}"/>'
            f'<circle cx="150" cy="172" r="22" fill="{a}" opacity=".85"/><path d="M54 232H246L236 250H64Z" fill="{c}"/><rect x="132" y="236" width="36" height="4" rx="2" fill="{d}"/>')
def o_headphones(c, d, a):
    return (f'<path d="M84 204Q84 106 150 106Q216 106 216 204" fill="none" stroke="{c}" stroke-width="12" stroke-linecap="round"/>'
            f'<rect x="68" y="190" width="38" height="78" rx="16" fill="{d}"/><rect x="194" y="190" width="38" height="78" rx="16" fill="{d}"/>'
            f'<rect x="76" y="204" width="14" height="50" rx="7" fill="{a}"/><rect x="210" y="204" width="14" height="50" rx="7" fill="{a}"/>')
def o_watch(c, d, a):
    return (f'<rect x="128" y="78" width="44" height="244" rx="10" fill="{d}"/><rect x="100" y="152" width="100" height="108" rx="26" fill="{c}"/>'
            f'<rect x="108" y="160" width="84" height="92" rx="20" fill="#0b0c0e"/><circle cx="150" cy="206" r="30" fill="none" stroke="{a}" stroke-width="4"/><path d="M150 206V186M150 206L164 214" stroke="{a}" stroke-width="3" stroke-linecap="round"/>')
def o_speaker(c, d, a):
    dots = ''.join(f'<circle cx="{x}" cy="{y}" r="3" fill="{d}"/>' for x in range(122, 182, 12) for y in range(150, 270, 14))
    return (f'<rect x="106" y="116" width="88" height="172" rx="28" fill="{c}"/>{dots}<rect x="106" y="116" width="88" height="14" rx="7" fill="{a}"/>')
def o_tablet(c, d, a):
    return (f'<rect x="74" y="98" width="152" height="206" rx="16" fill="{c}"/><rect x="84" y="110" width="132" height="182" rx="6" fill="{d}"/>'
            f'<rect x="98" y="128" width="104" height="60" rx="8" fill="{a}" opacity=".85"/><rect x="98" y="204" width="70" height="8" rx="4" fill="{a}" opacity=".5"/><rect x="98" y="222" width="90" height="8" rx="4" fill="{a}" opacity=".35"/>')
def o_earbuds(c, d, a):
    return (f'<rect x="96" y="176" width="108" height="86" rx="34" fill="{c}"/><path d="M96 214H204" stroke="{d}" stroke-width="3"/>'
            f'<circle cx="150" cy="194" r="4" fill="{a}"/><ellipse cx="124" cy="146" rx="13" ry="20" fill="{d}"/><ellipse cx="176" cy="146" rx="13" ry="20" fill="{d}"/>')
def o_powerbank(c, d, a):
    return (f'<rect x="108" y="104" width="84" height="196" rx="14" fill="{c}"/><rect x="122" y="124" width="56" height="8" rx="4" fill="{a}"/><rect x="122" y="142" width="40" height="8" rx="4" fill="{a}" opacity=".6"/>'
            f'<rect x="132" y="278" width="36" height="10" rx="3" fill="{d}"/>')
def o_dropper(c, d, a):
    return (f'<rect x="114" y="168" width="72" height="128" rx="12" fill="{c}"/><rect x="124" y="196" width="52" height="64" rx="4" fill="{a}" opacity=".9"/>'
            f'<rect x="132" y="138" width="36" height="32" rx="4" fill="{d}"/><rect x="141" y="92" width="18" height="50" rx="9" fill="{d}"/>')
def o_jar(c, d, a):
    return (f'<rect x="92" y="196" width="116" height="94" rx="12" fill="{c}"/><rect x="86" y="170" width="128" height="32" rx="8" fill="{d}"/>'
            f'<rect x="108" y="226" width="84" height="36" rx="4" fill="{a}" opacity=".9"/>')
def o_tube(c, d, a):
    return (f'<path d="M118 112H182L174 290H126Z" fill="{c}"/><rect x="122" y="290" width="56" height="26" rx="6" fill="{d}"/>'
            f'<rect x="132" y="170" width="36" height="60" rx="4" fill="{a}" opacity=".9"/>')
def o_lipstick(c, d, a):
    return (f'<rect x="120" y="206" width="60" height="94" rx="6" fill="{d}"/><rect x="124" y="164" width="52" height="46" fill="{c}"/>'
            f'<path d="M126 164L150 112L176 164Z" fill="{a}"/><rect x="120" y="226" width="60" height="6" fill="{c}"/>')
def o_compact(c, d, a):
    return (f'<circle cx="150" cy="202" r="68" fill="{c}"/><circle cx="150" cy="202" r="50" fill="{a}"/><circle cx="150" cy="202" r="26" fill="{d}" opacity=".55"/>'
            f'<rect x="138" y="128" width="24" height="10" rx="4" fill="{d}"/>')
def o_mask(c, d, a):
    return (f'<rect x="100" y="112" width="100" height="180" rx="12" fill="{c}"/><rect x="100" y="112" width="100" height="22" rx="6" fill="{d}"/>'
            f'<ellipse cx="150" cy="212" rx="26" ry="34" fill="{a}" opacity=".85"/>')
def o_pump(c, d, a):
    return (f'<rect x="108" y="170" width="84" height="126" rx="14" fill="{c}"/><rect x="144" y="124" width="12" height="48" fill="{d}"/>'
            f'<path d="M138 124H178L178 112H146Z" fill="{d}"/><rect x="122" y="206" width="56" height="50" rx="4" fill="{a}" opacity=".9"/>')
def o_tagine(c, d, a):
    return (f'<path d="M72 236Q150 262 228 236L212 282Q150 300 88 282Z" fill="{d}"/><path d="M88 236Q150 66 212 236Z" fill="{c}"/>'
            f'<circle cx="150" cy="118" r="10" fill="{a}"/><path d="M118 226Q150 150 182 226" fill="none" stroke="{a}" stroke-width="3" opacity=".6"/>')
def o_mahshi(c, d, a):
    rolls = ''.join(f'<ellipse cx="{x}" cy="{y}" rx="30" ry="12" fill="{c}" transform="rotate({r} {x} {y})"/>' for x, y, r in
                    [(122, 208, -14), (178, 208, 14), (116, 236, 8), (184, 236, -8), (150, 222, 0)])
    return (f'<ellipse cx="150" cy="240" rx="108" ry="46" fill="{d}"/><ellipse cx="150" cy="236" rx="90" ry="34" fill="{a}" opacity=".5"/>{rolls}'
            f'<path d="M108 202Q150 186 192 202" fill="none" stroke="{a}" stroke-width="4" stroke-linecap="round"/>')
def o_sweets(c, d, a):
    cells = ''.join(f'<path d="M{x} {y}l22 -16l22 16l-22 16Z" fill="{c}"/><circle cx="{x+22}" cy="{y}" r="3.5" fill="{a}"/>' for x in (70, 114, 158) for y in (206, 238, 270))
    return f'<rect x="56" y="170" width="188" height="130" rx="10" fill="{d}"/>{cells}'
def o_bowl(c, d, a):
    return (f'<path d="M64 226H236Q236 306 150 306Q64 306 64 226Z" fill="{d}"/><path d="M84 226Q150 120 216 226Z" fill="{c}"/>'
            f'<circle cx="130" cy="196" r="6" fill="{a}"/><circle cx="160" cy="180" r="6" fill="{a}"/><circle cx="178" cy="208" r="6" fill="{a}"/>')
def o_pickles(c, d, a):
    bits = ''.join(f'<ellipse cx="{x}" cy="{y}" rx="9" ry="16" fill="{a}" transform="rotate({r} {x} {y})"/>' for x, y, r in [(128, 220, 20), (160, 232, -15), (140, 262, 70), (176, 266, 40)])
    return (f'<rect x="102" y="168" width="96" height="130" rx="14" fill="{c}" opacity=".9"/>{bits}<rect x="108" y="146" width="84" height="26" rx="6" fill="{d}"/>')
def o_feteer(c, d, a):
    layers = ''.join(f'<ellipse cx="150" cy="{y}" rx="{rx}" ry="20" fill="{c if i % 2 == 0 else a}"/>' for i, (y, rx) in enumerate([(266, 100), (240, 94), (214, 86), (188, 76)]))
    return layers + f'<ellipse cx="150" cy="176" rx="40" ry="10" fill="{d}"/>'
def o_kunafa(c, d, a):
    lines = ''.join(f'<path d="M{150+dx*cos} 0" />' for dx, cos in [])
    st = ''.join(f'<path d="M{x} 206Q{x+4} 236 {x} 268" stroke="{a}" stroke-width="3" fill="none" opacity=".7"/>' for x in range(84, 220, 14))
    return (f'<ellipse cx="150" cy="240" rx="112" ry="52" fill="{d}"/><ellipse cx="150" cy="232" rx="98" ry="42" fill="{c}"/>{st}'
            f'<circle cx="150" cy="226" r="9" fill="{a}"/>')
def o_tomatoes(c, d, a):
    t = ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}"/><path d="M{x-8} {y-r+4}l8 6l8 -6l-8 -2Z" fill="{d}"/>' for x, y, r in [(112, 250, 38), (190, 244, 36), (152, 196, 40)])
    return t
def o_herbs(c, d, a):
    leaves = ''.join(f'<ellipse cx="150" cy="170" rx="14" ry="62" fill="{c if i % 2 == 0 else d}" transform="rotate({r} 150 250)"/>' for i, r in enumerate(range(-52, 60, 16)))
    return leaves + f'<rect x="130" y="244" width="40" height="22" rx="4" fill="{a}"/><rect x="141" y="266" width="18" height="40" rx="3" fill="{d}"/>'
def o_fruit(c, d, a):
    return ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{col}"/><circle cx="{x-r*0.3}" cy="{y-r*0.3}" r="{r*0.18}" fill="#fff" opacity=".3"/>' for x, y, r, col in
                   [(112, 252, 38, c), (190, 248, 38, d), (150, 200, 42, a)]) + f'<path d="M150 158q10 -22 28 -20q-8 18 -28 20Z" fill="{d}"/>'
def o_crate(c, d, a):
    eggs = ''.join(f'<ellipse cx="{x}" cy="206" rx="13" ry="17" fill="{a}"/>' for x in (96, 124, 152, 180, 208))
    return (f'{eggs}<rect x="70" y="214" width="160" height="82" rx="6" fill="{c}"/><path d="M70 238H230M70 262H230" stroke="{d}" stroke-width="3"/>'
            f'<ellipse cx="124" cy="190" rx="38" ry="12" fill="{d}" opacity="0"/>')
def o_lantern(c, d, a):
    return (f'<circle cx="150" cy="200" r="86" fill="{a}" opacity=".18"/><circle cx="150" cy="200" r="52" fill="{a}" opacity=".25"/>'
            f'<rect x="144" y="84" width="12" height="22" fill="{d}"/><path d="M124 108H176L190 150H110Z" fill="{c}"/>'
            f'<path d="M110 150H190L200 250H100Z" fill="{c}" opacity=".95"/><path d="M130 150V250M150 150V250M170 150V250" stroke="{d}" stroke-width="3"/>'
            f'<ellipse cx="150" cy="200" rx="18" ry="30" fill="{a}"/><path d="M100 250H200L184 280H116Z" fill="{c}"/>')
def o_window(c, d, a):
    return (f'<path d="M60 320V150Q60 70 150 70Q240 70 240 150V320Z" fill="{d}"/><path d="M76 320V152Q76 86 150 86Q224 86 224 152V320Z" fill="{c}"/>'
            f'<rect x="136" y="150" width="28" height="8" rx="4" fill="{a}"/><path d="M122 164H178L190 206L172 224L206 312H94L128 224L110 206Z" fill="{a}"/><ellipse cx="150" cy="140" rx="12" ry="14" fill="{a}"/>')
def o_figure(c, d, a):  # editorial model, simplified
    return (f'<ellipse cx="150" cy="106" rx="24" ry="28" fill="#c58f6e"/><path d="M124 100Q124 66 150 66Q178 66 176 104Q168 84 150 84Q132 84 124 100Z" fill="#2a1a14"/>'
            f'<rect x="141" y="128" width="18" height="22" fill="#b27c5c"/><path d="M114 150Q150 138 186 150L204 316H96Z" fill="{c}"/>'
            f'<path d="M114 150L88 250L104 254L128 176Z" fill="{c}"/><path d="M186 150L212 250L196 254L172 176Z" fill="{c}"/>'
            f'<rect x="124" y="196" width="52" height="10" fill="{a}"/><path d="M150 150V316" stroke="{d}" stroke-width="2" opacity=".4"/>')
def o_face(c, d, a):  # cook portrait with headscarf
    return (f'<path d="M72 330Q72 250 150 244Q228 250 228 330Z" fill="{a}"/><ellipse cx="150" cy="170" rx="74" ry="88" fill="{c}"/>'
            f'<ellipse cx="150" cy="176" rx="50" ry="62" fill="#d6a283"/><circle cx="130" cy="166" r="4.5" fill="#2a1a14"/><circle cx="170" cy="166" r="4.5" fill="#2a1a14"/>'
            f'<path d="M132 204Q150 222 168 204" fill="none" stroke="#7a3b2e" stroke-width="4" stroke-linecap="round"/><path d="M122 154Q130 148 138 153M162 153Q170 148 178 154" stroke="#2a1a14" stroke-width="2.5" fill="none"/>'
            f'<path d="M76 190Q76 96 150 90Q224 96 224 190Q224 130 150 122Q76 130 76 190Z" fill="{c}"/>')

OBJ = {k[2:]: v for k, v in globals().items() if k.startswith('o_')}

def art(kind, bg1, bg2, c, d, a, scale=1.0, extra=''):
    body = OBJ[kind](c, d, a)
    if scale != 1.0:
        body = f'<g transform="translate({150*(1-scale)} {200*(1-scale)}) scale({scale})">{body}</g>'
    sh = '' if kind in ('lantern', 'window', 'figure', 'face') else shade()
    return _uri(extra + sh + body, bg1, bg2)

def swatch_uri(name, bg, ink):
    """solid colour block with the product name – used only if an art kind is missing"""
    return _uri(f'<text x="150" y="200" text-anchor="middle" font-size="22" fill="{ink}">{name}</text>', bg, bg)
