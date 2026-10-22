# Prompts for the Dahab demo catalogue (B5 Task 5). AI-generated ILLUSTRATIVE samples (Ruling TPL-3,
# B5-11): not a real jeweller's pieces. One prompt per output file; gen.py writes img-src/<name>.jpg and
# encode.sh crops/encodes it to assets/<name>.webp. `C` names the aspect each file is cut to.
# Rules (Rulings B5-2, B5-11): no logos, brand marks, hallmark stamps, lettering or readable engraving
# (FLUX invents text: boxes and cards are plain and blank, and no prompt word describes text or layout);
# no people and no skin (skin reads as orange to the probe); NO orange subject: FLUX reads a negated
# colour word as a positive one, so the prompts only NAME the colours wanted. Gold jewellery is
# photographed as pale champagne-toned metal in cool neutral daylight on grey, white or green grounds so
# it stays out of the orange hue band. Every output is viewed before commit and probed by
# orange-probe.py (hue 12-50, HSV saturation >= 35 %, <= 2 % of the pixels).
NEG = "plain unmarked surfaces, no lettering, no engraving text, no hallmark, no people, no hands"
LIGHT = "soft cool neutral daylight, sharp realistic product photograph, pale champagne-toned metal"
PACK_GROUND = "on a clean seamless white to pale grey studio ground, soft diffuse shadow under it, one subject centered"
STONE_GROUND = "lying on a plain pale grey linen cloth, shot from slightly above"


def pack(subject, extra=""):
    return f"{subject}, {PACK_GROUND}, {LIGHT}, {extra} {NEG}".replace("  ", " ").strip()


def stone(subject, extra=""):
    return f"{subject}, {STONE_GROUND}, {LIGHT}, {extra} {NEG}".replace("  ", " ").strip()


P = {}
C = {}  # name -> crop: 'square' (1:1 product), 'dish' (4:3) or 'wide' (16:9 hero)


def add(name, prompt, crop):
    P[name] = prompt
    C[name] = crop


# ---- heroes (one per look: Worn, Workshop, Gift box)
add('hero-worn', stone("a slim ring and a fine chain lying near a window in north light, pale grey and white only"), 'wide')
add('hero-workshop', "a jeweller's bench seen from slightly above, steel pliers and a small hammer, a ring on a steel mandrel, a shallow tray of small turquoise blue enamel dishes, pale grey and steel blue and turquoise only, soft cool neutral daylight, sharp realistic photograph, " + NEG, 'wide')
add('hero-giftbox', "an open deep emerald green gift box with a white satin ribbon, a small white ring box inside, on a white ground, deep green and white only, soft cool neutral daylight, sharp realistic photograph, " + NEG, 'wide')

# ---- rings
add('ring-solitaire', pack("a slim solitaire ring with one small clear stone in four claws on a thin pale champagne metal band"), 'square')
add('ring-silver', pack("a plain polished silver band ring"), 'square')
add('ring-engraved', pack("a smooth wide pale champagne metal band ring with a blank polished inside"), 'square')
add('ring-signet', pack("a small oval signet ring in pale champagne metal with a blank flat top"), 'square')

# ---- necklaces and pendants
add('necklace-chain', pack("a fine cable chain necklace in pale champagne metal coiled in a loose circle"), 'square')
add('necklace-name', pack("a delicate pale champagne metal chain with a small blank flat plate pendant"), 'square')
add('necklace-pearl', pack("a single strand of round white pearls with a small silver clasp, laid in a loose arc"), 'square')
add('pendant-heart', pack("a small smooth heart shaped pendant on a fine silver chain"), 'square')

# ---- bracelets and bangles
add('bangle-plain', pack("a plain smooth round bangle bracelet in pale champagne metal, standing upright"), 'square')
add('bracelet-tennis', pack("a thin tennis bracelet of small clear stones in a silver setting, laid in a loose circle"), 'square')
add('bracelet-charm', pack("a fine silver chain bracelet with three tiny blank round charms, laid in a loose circle"), 'square')
add('anklet', pack("a delicate silver anklet chain with tiny round beads, laid in a loose circle"), 'square')

# ---- earrings
add('earrings-hoop', pack("a pair of small round hoop earrings in pale champagne metal, side by side"), 'square')
add('earrings-pearl', pack("a pair of round white pearl stud earrings, side by side"), 'square')
add('earrings-drop', pack("a pair of slim drop earrings with a small clear stone hanging from a silver hook, side by side"), 'square')

# ---- sets
add('set-bridal', pack("a matching set of a short pearl necklace, two pearl drop earrings and a plain silver ring, laid out together on one plain surface, white and silver and pale grey only"), 'dish')
add('set-mini', pack("a matching mini set of a tiny silver pendant on a chain and two small silver stud earrings, laid out together"), 'dish')

# ---- gold-rate pieces that are bars and coins
add('gold-bar', pack("a thin flat rectangular plate of pale champagne-toned metal lying flat on the surface, small and smooth, perfectly plain polished top"), 'square')
add('gold-coin', pack("a round plain coin with a blank smooth face in pale champagne-toned metal, standing slightly tilted"), 'square')

# ---- gifts
add('gift-box', pack("a small deep emerald green jewellery gift box with a white satin ribbon bow, closed"), 'square')
add('gift-card', pack("a plain white card envelope tied with an emerald green satin ribbon, no printing on it"), 'square')
