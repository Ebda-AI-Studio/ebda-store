# Prompts for the Jasmine demo catalogue (B3 Task 5). AI-generated ILLUSTRATIVE samples (Ruling TPL-3,
# B3-9): not a real merchant's products. One prompt per output file; gen.py writes img-src/<name>.jpg
# and encode.sh crops/encodes it to assets/<name>.webp. `C` names the aspect each file is cut to.
# Rules (Rulings B3-3, B3-9): no logos, brand marks, lettering or readable labels (FLUX invents text:
# packaging is plain and blank); NO orange, amber, gold or warm yellow light anywhere (Ruling B3-2):
# glass is clear, jade or cobalt, never amber/brown; NO faces, hands or skin close-ups. Every output is
# viewed before commit and probed by orange-probe.py.
NEG = ("no text, no letters, no numbers, no logo, no brand mark, no watermark, no label text, "
       "blank unmarked packaging, no orange, no amber, no gold, no warm yellow light, "
       "no people, no face, no hands, no skin")
GROUND = "on a clean seamless white to pale cool grey studio ground, soft diffuse shadow under it"
LOOK = "sharp realistic product photograph, centered with breathing room, cool neutral daylight"


def prod(subject, extra=""):
    return f"{subject}, {GROUND}, {LOOK}, {extra} {NEG}".replace("  ", " ").strip()


P = {}
C = {}  # name -> crop: 'square' (1:1, products) or 'wide' (16:9, heroes)


def add(name, prompt, crop='square'):
    P[name] = prompt
    C[name] = crop


# ---- cleansers
add('gentle-cleanser', prod("a tall white plastic pump bottle with a clear gel cleanser visible at the base, plain smooth surface with an empty blank label area"))
add('creamy-cleanser', prod("a soft white squeezable tube standing on its cap, completely plain smooth surface, an empty blank band where a label would be"))
add('micellar-water', prod("a clear transparent bottle of water-clear liquid with a plain white pump top, no label at all"))
# ---- serums and treatments
add('niacinamide-serum', prod("a small frosted clear glass dropper bottle with a white rubber bulb, filled with clear liquid, plain glass with no printing"))
add('vitamin-c-serum', prod("a small cobalt blue glass dropper bottle with a white rubber bulb, plain glass with no printing, no yellow liquid"))
add('hyaluronic-serum', prod("a small pale jade green glass dropper bottle with a silver metal collar and a white bulb, plain glass with no printing"))
add('retinol-night-cream', prod("a slim cobalt blue airless pump bottle with a white pump cap, large in the frame, completely plain with no printing"))
add('spot-patches', prod("a round white plastic case with a flat lid sitting beside a few small round transparent clear patches, plain case with no printing"))
# ---- moisturisers and sunscreen
add('ceramide-moisturiser', prod("a wide white ceramic style cream jar with a matching white lid, plain smooth surface, no label"))
add('gel-moisturiser', prod("a clear translucent aqua tinted plastic jar with a white lid containing a clear aqua gel, plain surface, no label"))
add('sunscreen', prod("a white squeezable tube with a flip cap, lying slightly angled, completely plain surface with an empty blank band where a label would be"))
add('lip-balm', prod("a small white stick style lip balm tube capped, plain surface, no label"))
# ---- makeup
add('matte-lipstick', prod("a black matte lipstick tube open showing a deep berry rose coloured bullet, next to its cap, plain casing with no markings"))
add('cream-blush', "a small round white compact open showing a deep fuchsia magenta berry pink cream blush, a saturated cool pink like a raspberry, " + GROUND + ", " + LOOK + ", plain unprinted smooth surfaces, cool neutral daylight, cool palette of white, blue, green and pink")
add('lip-oil', "a clear glass lip oil tube with a smooth white cap filled with a glossy raspberry magenta pink liquid, " + GROUND + ", " + LOOK + ", plain unprinted smooth surfaces, cool neutral daylight, cool palette of white, blue, green and pink")
add('mascara', prod("a slim black mascara tube with a black wand lying beside it, plain casing with no markings"))
# ---- perfumes
add('oud-rose-perfume', "a rectangular heavy clear glass perfume bottle filled with transparent water-clear liquid, a smooth matte silver cap, " + GROUND + ", " + LOOK + ", plain unprinted smooth surfaces, cool neutral daylight, cool palette of white, blue, green and pink")
add('musk-mist', prod("a slim frosted white glass spray bottle with a plain white spray cap, no label, no text"))
# ---- hair care
add('shampoo', prod("a white plastic shampoo bottle with a flip cap, plain smooth surface with an empty blank label area"))
add('argan-hair-oil', "a small clear glass bottle with a silver pump dropper, filled with transparent water-clear liquid, " + GROUND + ", " + LOOK + ", plain unprinted smooth surfaces, cool neutral daylight, cool palette of white, blue, green and pink")
# ---- tools
add('sonic-face-brush', prod("a soft pale jade green silicone facial cleansing brush device with a round bristle head, smooth plain body, no buttons printed, no logo"))
# makeup-brush-set has NO photo on purpose (the no-image product)
# ---- heroes (16:9)
add('hero-apothecary', ("a still life of glass bottles in jade green, clear and cobalt blue glass with small brushed silver metal caps standing on a dark "
                        "olive green linen surface, a few green leaves, rolled oats and jojoba seeds beside them, cool soft daylight, "
                        "muted deep olive green background, the centre of the frame left calm, plain unprinted smooth bottles, "
                        "cinematic photograph, cool palette of green, blue and silver"), 'wide')
add('hero-bloom', ("a wide shelf in front of a soft cool blush pink wall with magenta-leaning rose tones holding a row of cosmetic tubes and compacts in rose pink and berry colours, "
                   "soft cool daylight, clean and playful, blank unmarked packaging, space on the left side of the frame, "
                   "cinematic photograph, " + NEG + ", no coral, no peach, no salmon, no orange tones, no warm light"), 'wide')
add('hero-clinic', ("a quiet lineup of three smooth plain featureless white and pale aqua skincare bottles and a tube on a white tile surface with a soft aqua "
                    "backdrop, clinical clean look, cool bright daylight, the packaging is completely blank and smooth, no printing of any kind, no lettering, no symbols, "
                    "calm empty space around them, cinematic photograph, " + NEG), 'wide')
