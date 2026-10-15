# Prompts for the Qamar demo catalogue (B1 Task 6). AI-generated ILLUSTRATIVE samples (Ruling TPL-3):
# not a real merchant's products. One prompt per output file; gen.py writes img-src/<name>.jpg and
# encode.sh crops/encodes it to assets/<name>.webp. `CROP` names the aspect each file is cut to.
NEG = "no text, no letters, no logo, no watermark, no signage"

ATELIER = ("bright minimalist atelier at noon, soft daylight, pure white walls, editorial fashion photography, "
           "ink black and deep oxblood accents")
LOOKBOOK = "Cairo rooftop at golden hour, deep indigo and saffron palette, warm editorial lookbook photography"
VITRINE = ("evening Heliopolis boutique lit from inside, dusty rose, deep teal and champagne gold palette, "
           "elegant fashion photography")


def pp(subject, style=ATELIER, bg="plain white studio wall"):
    return (f"{subject}, {bg}, {style}, subject centered with breathing room, sharp realistic photograph, "
            f"modest styling, {NEG}")


def worn(garment, style=ATELIER, bg="plain white studio wall"):
    # Head cropped out of frame: fewer face artefacts, the garment is the subject.
    return pp(f"front view of an adult Egyptian woman in a matching headscarf wearing {garment}, full-length, "
              "long sleeves, calm natural pose, arms relaxed at her sides", style, bg)


def hung(garment, style=ATELIER):
    return pp(f"{garment} hanging on a wooden hanger on a slim black rail, plain white wall with nothing on it", style)


FORM = "a plain unmarked white dress form with no tags and no labels"


def detail(what, style=ATELIER):
    return pp(f"close-up detail of {what}, fabric texture filling the frame", style, "soft daylight")


P = {}
C = {}  # name -> crop: 'portrait' (3:4), 'wide' (16:9), 'swatch' (centre square, 60%)

def add(name, prompt, crop='portrait'):
    P[name] = prompt
    C[name] = crop

# ---- products: front + detail (the no-image product has none, on purpose)
add('linen-abaya-1', worn("a loose dusty rose linen abaya with wide sleeves"))
add('linen-abaya-2', detail("dusty rose linen abaya sleeve hem with fine stitching"))
add('embroidered-kaftan-1', hung("an ivory white kaftan with deep oxblood hand embroidery around the neckline"))
add('embroidered-kaftan-2', detail("oxblood silk hand embroidery on ivory kaftan fabric"))
add('crepe-abaya-sale-1', worn("a flowing black crepe abaya with a soft drape"))
add('crepe-abaya-sale-2', detail("black crepe fabric folds and a simple cuff"))
add('chiffon-scarf-1', pp("a softly folded dusty rose chiffon headscarf on a white plinth"))
add('chiffon-scarf-2', pp("seven folded chiffon scarves in a row in rose, teal, black, ivory, mauve, olive and navy, on a white table, seen from above"))
add('evening-gown-rose-1', pp(f"a muted dusty rose satin evening gown with a high neckline and long sleeves on {FORM}", VITRINE, "soft grey-white background"))
add('evening-gown-rose-2', detail("muted desaturated dusty rose satin fabric folds with a soft sheen, mauve pink, not bright", VITRINE))
add('hand-embroidered-abaya-1', pp(f"a long black abaya with fine gold thread hand embroidery down the front and a slim brown leather belt, long wide sleeves, on {FORM}"))
add('hand-embroidered-abaya-2', detail("gold thread hand embroidery on black abaya fabric"))
add('classic-black-abaya-1', hung("a classic plain black abaya, floor-length, long sleeves, round neckline"))
add('classic-black-abaya-2', detail("black crepe abaya fabric at a closed round collar with a hidden button placket, no skin visible"))
add('open-front-abaya-1', pp(f"a navy blue open-front long abaya worn open over a white long dress, long sleeves, on {FORM}"))
add('open-front-abaya-2', detail("navy blue abaya front edge with a thin piping"))
add('linen-kaftan-1', hung("a teal linen kaftan with short slits at the sides"))
add('linen-kaftan-2', detail("teal linen weave and a wooden button"))
add('velvet-kaftan-1', pp(f"a floor-length deep oxblood velvet kaftan with long wide sleeves on {FORM}"))
add('velvet-kaftan-2', detail("deep oxblood velvet pile with a soft sheen"))
add('silk-shawl-1', pp("a plain pale champagne gold silk shawl, one solid colour, softly draped over a white chair"))
add('silk-shawl-2', detail("plain pale champagne gold silk with a hand-rolled hem, one solid colour"))
add('cotton-scarf-set-1', pp("exactly three folded cotton headscarves stacked on a white table: black on the bottom, ivory in the middle, tobacco brown on top"))
add('cotton-scarf-set-2', detail("folded matte tobacco brown cotton jersey headscarf, soft knit texture, one solid colour"))
add('satin-midi-dress-1', pp(f"a deep teal satin midi dress, mid-calf length, two long sleeves, symmetric, on {FORM}", VITRINE, "soft grey-white background"))
add('satin-midi-dress-2', detail("deep teal satin sleeve cuff with a small covered button, one solid teal colour", VITRINE))
add('tulle-engagement-dress-1', pp("a blush pink tulle engagement dress with long sleeves on a dress form", VITRINE, "soft grey-white background"))
add('tulle-engagement-dress-2', detail("layers of blush pink tulle", VITRINE))
add('beaded-evening-dress-1', pp("a champagne gold beaded evening dress with long sleeves on a dress form", VITRINE, "soft grey-white background"))
add('beaded-evening-dress-2', detail("pale champagne gold beads embroidered in a floral pattern on a pale champagne sleeve, one pale colour, no words", VITRINE))
add('wedding-guest-kaftan-1', pp(f"a long dusty rose chiffon kaftan with champagne trim, long sleeves, on {FORM}", VITRINE, "soft grey-white background"))
add('wedding-guest-kaftan-2', detail("champagne trim on dusty rose chiffon", VITRINE))
add('pleated-dress-1', hung("a long plum pleated dress with long sleeves"))
add('pleated-dress-2', detail("fine knife pleats in plum fabric"))

# ---- swatch fabrics
add('swatch-rose-linen', pp("top-down flat lay of a smooth piece of dusty rose linen fabric, the fabric covers the entire image edge to edge, no table, no wall", ATELIER, "fabric only"), 'swatch')
add('swatch-teal-linen', pp("macro photograph of deep teal linen weave, the fabric fills the entire frame edge to edge, no background visible", ATELIER, "fabric only"), 'swatch')

# ---- heroes, one per look (C10)
add('hero-atelier', pp("wide shot, a small full-length figure of an adult Egyptian woman in a matching headscarf and a long dusty rose linen abaya standing in the right third, "
                        "head and feet fully in frame, a single empty clothing rail on the left, large empty white wall",
                        ATELIER, "pure white studio with a tall window light"), 'wide')
add('hero-vitrine', pp("a single dusty rose satin evening gown with long sleeves and a high neckline on a mannequin seen through a tall arched glass window "
                       "with a deep teal frame, plain empty walls inside, warm glow", "evening boutique window lit warmly from inside, dusty rose, deep teal and champagne palette, elegant fashion photography",
                       "dusk, soft blurred reflections, plain glass with nothing written on it"), 'wide')

# ---- lookbook (Lookbook collage hero)
add('lookbook-1', worn("an indigo linen kaftan and a saffron silk scarf", LOOKBOOK, "Cairo rooftop at golden hour"))
add('lookbook-2', worn("a saffron yellow modest long dress", LOOKBOOK, "rooftop terrace with indigo shadows"))
add('lookbook-3', worn("a black abaya open over an indigo dress", LOOKBOOK, "empty rooftop at golden hour, clean sky"))

# ---- shop-the-look (Task 7)
add('look-1', worn("a dusty rose linen abaya and a chiffon headscarf draped on the shoulders", LOOKBOOK, "rooftop golden hour"))
add('look-2', worn("a deep teal satin midi dress with a champagne silk shawl", LOOKBOOK, "rooftop terrace at dusk"))
add('look-3', worn("an ivory kaftan with oxblood embroidery and an olive cotton scarf", LOOKBOOK, "warm rooftop light"))

# ---- occasions (Vitrine bands, Task 8)
add('occasion-wedding', pp("a champagne beaded gown on a mannequin beside a vase of white roses", VITRINE, "boutique interior"), 'wide')
add('occasion-engagement', pp("a blush tulle dress with long sheer sleeves and a high neckline on a mannequin beside soft pink flowers", VITRINE, "boutique interior"), 'wide')
add('occasion-evening', pp("a deep teal blue-green satin long dress with long sleeves on a mannequin under warm lamp light, the dress is clearly teal", VITRINE, "boutique interior at night"), 'wide')

# ---- full-bleed image break (Atelier)
add('break-atelier', pp("a row of abayas in black, dusty rose and ivory hanging on a long rail in an empty white atelier, "
                        "wide view, lots of white space", ATELIER, "white walls and pale floor"), 'wide')
