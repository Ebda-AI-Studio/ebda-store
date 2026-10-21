# Prompts for the Souq demo catalogue (B2 Task 6). AI-generated ILLUSTRATIVE samples (Ruling TPL-3,
# B2-10): not a real merchant's products. One prompt per output file; gen.py writes img-src/<name>.jpg
# and encode.sh crops/encodes it to assets/<name>.webp. `C` names the aspect each file is cut to.
# Rules (Ruling B2-10): no logos, brand marks, lettering or readable screens (devices are dark and
# abstract); NO orange, amber, gold or warm yellow anywhere (Ruling B2-2): the palette is grey, ink,
# jade, turquoise and cobalt. Every output is viewed before commit and probed by orange-probe.py.
NEG = ("no text, no letters, no numbers, no logo, no brand mark, no watermark, no packaging text, "
       "no orange, no amber, no gold, no warm yellow light")
GROUND = "on a clean seamless light grey studio ground, soft diffuse shadow under it"
LOOK = "sharp realistic product photograph, centered with breathing room, neutral cool lighting"


def prod(subject, extra=""):
    return f"{subject}, {GROUND}, {LOOK}, {extra} {NEG}".replace("  ", " ").strip()


NIGHT_PAL = "jade green, turquoise and deep green light"
P = {}
C = {}  # name -> crop: 'square' (1:1, products) or 'wide' (16:9, heroes)


def add(name, prompt, crop='square'):
    P[name] = prompt
    C[name] = crop


# ---- phones
add('smartphone', prod("a modern slate-black smartphone with a large dark blank screen, seen from the front and slightly angled, thin bezels, no logo on the back"))
add('budget-phone', prod("a cobalt blue budget smartphone with a dark blank screen, slightly angled, plain back without any mark"))
add('refurbished-phone', prod("a plain matte silver smartphone with an edge-to-edge dark blank screen and no home button, thin silver frame, no rose gold, no camera bump markings"))
add('used-phone', prod("a dark graphite smartphone with a blank dark screen, in a clear protective case, plain back"))
# ---- laptops and tablets
add('student-laptop', prod("a 15.6 inch silver laptop CLOSED, seen from the front-left at an angle, the plain smooth silver lid facing the camera with no logo, no marks, no keyboard visible"))
add('ultrabook', prod("a thin 14 inch dark grey ultrabook laptop open at an angle, dark blank screen, keyboard keys without any letters, no logo"))
add('tablet', prod("a 10 inch tablet in a slate grey case standing upright, dark blank screen, no logo"))
# ---- audio
add('headphones', prod("over-ear wireless headphones in matte dark grey with soft ear cushions, no logo, no text on the band"))
add('earbuds', prod("true wireless earbuds in a small white charging case with the lid open, plain surfaces, no logo"))
add('speaker', prod("a portable cylindrical bluetooth speaker in deep jade green fabric with a plain rubber base, the front completely plain with no label, no badge and no printing"))
# ---- watches
add('smartwatch', prod("a round smartwatch with a dark blank display and a dark grey silicone strap, no logo, no numbers on the screen"))
add('fitness-band', prod("a slim fitness band with a dark blank display, a plain dark grey metal-free bezel and a deep teal silicone strap, no gold, no copper, no logo"))
# ---- tv and screens
add('tv-55', prod("a flat 55 inch television seen from the front on a thin stand, completely dark blank screen, the whole frame and bottom edge are perfectly plain smooth black with no marks, no badge, no logo, no text, no small symbols"))
add('tv-43', prod("a flat 43 inch television seen from the front on two small feet, completely dark blank screen, the whole frame and bottom edge are perfectly plain smooth black with no marks, no badge, no logo, no text, no small symbols"))
add('monitor', prod("a 27 inch computer monitor on a simple stand seen from the front, completely dark blank screen, no logo"))
# ---- appliances
add('washing-machine', prod("a front-loading washing machine in plain white with a round dark glass door, the whole front perfectly plain white, only one round dial on top, no display, no printing, no markings around the dial, no text, no logo"))
add('air-fryer', prod("a black air fryer with the empty basket pulled halfway out, plain smooth control panel with no markings, no food, no text, no logo"))
add('kettle', prod("a plain stainless steel electric kettle with a black handle and a round power base, completely smooth surfaces with no markings, no scale, no text, no logo, no badge"))
# ---- accessories
add('power-bank', prod("a slim slate-black power bank with a short USB cable coiled beside it, plain surface, no text, no logo"))
# phone-case-set has NO photo on purpose (the no-image product)
# ---- heroes (16:9)
add('hero-night', ("a long stone arcade corridor of a souq at night with plain blank arched walls and no shops, lit only by "
                   "glowing jade green and turquoise glass lanterns hanging in a row, deep teal darkness, one dark slate "
                   "smartphone with a blank dark screen standing on a plain dark pedestal in the foreground, cinematic "
                   "photograph, no signs, no signage, no windows with displays, no people, " + NEG + ", no red lights, "
                   "no yellow lights, no orange lanterns"), 'wide')
add('hero-showroom', ("one dark grey smartphone standing upright on a light grey showroom table, empty light grey "
                      "wall behind it, soft overhead daylight, minimal, wide empty space on the right, " + NEG), 'wide')
