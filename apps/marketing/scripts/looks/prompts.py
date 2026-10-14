NEG = "no text, no letters, no logo, no watermark"
def pp(subject, bg, style): return f"{subject}, {bg}, {style}, subject centered with breathing room around it, sharp realistic photograph, {NEG}"
S = {}
# ---- Qamar A atelier
st = "bright minimalist Zamalek atelier, soft noon daylight, white walls, editorial fashion photography, ink black and deep oxblood accents"
S['qa'] = {
 'hero': pp("full-length Egyptian woman in a modest contemporary white linen shirt and wide trousers standing beside a single clothing rail", "pure white studio wall", st),
 'coat': pp("long charcoal cotton coat hanging on a rail", "white wall", st),
 'shirt': pp("folded white linen shirt", "clean white surface", st),
 'trousers': pp("black wide-leg trousers hanging on a rail", "white wall", st),
 'dress': pp("oxblood midi dress on a hanger", "white wall", st),
 'bag': pp("black leather handbag on a white plinth", "white background", st)}
# ---- Qamar B lookbook
st = "Cairo rooftop at golden hour, deep indigo and saffron colour palette, warm editorial lookbook photography"
S['qb'] = {
 'figure': pp("Egyptian woman in modest contemporary indigo jacket and denim, rooftop", "Cairo skyline at golden hour", st),
 'dress': pp("saffron yellow midi dress on a woman, modest contemporary", "rooftop golden hour", st),
 'sneaker': pp("clean leather sneakers on a rooftop ledge", "golden hour, indigo shadows", st),
 'shirt': pp("oversized white shirt on an Egyptian woman, modest style", "rooftop golden hour", st),
 'coat': pp("indigo jacket flat lay", "dark indigo fabric background", st),
 'trousers': pp("blue denim trousers flat lay", "dark indigo background", st),
 'bag': pp("saffron yellow crossbody bag", "deep indigo background", st)}
# ---- Qamar C vitrine
st = "evening Heliopolis boutique window lit from inside, dusty rose, deep teal and champagne gold palette, elegant fashion photography"
S['qc'] = {
 'window': pp("single dusty rose satin evening gown on a mannequin, seen through a large arched glass window with a deep teal painted frame, empty plain walls inside, warm glow", "dusk, blurred reflections", "dusty rose, deep teal and champagne gold palette, elegant fashion photography, clean minimal interior with blank surfaces"),
 'dress': pp("dusty rose satin evening dress on a mannequin", "soft grey-white background", st),
 'heels': pp("champagne gold high heel shoes", "soft grey-white background", st),
 'bag': pp("champagne gold beaded clutch", "soft grey-white background", st),
 'shirt': pp("dusty rose silk blouse", "soft grey-white background", st),
 'trousers': pp("deep teal tailored evening trousers", "soft grey-white background", st)}
# ---- Souq
def prod(item, bg, extra): return pp(f"clean studio product photograph of {item}", bg, extra)
st = "bright, organised, crisp commercial product photography"
S['sa'] = {k: prod(v, "pure white background", st) for k, v in dict(
 phone="a modern black smartphone", laptop="a slim silver laptop open", headphones="black wireless over-ear headphones", watch="a black smartwatch",
 tablet="a tablet with a dark screen", powerbank="a black power bank with a blue accent", earbuds="white wireless earbuds with charging case", speaker="a portable bluetooth speaker").items()}
st = "Khan el-Khalili at dusk, glowing brass lanterns, deep green and brass colour palette, warm moody commercial photography"
S['sb'] = {k: prod(v, "deep green background with warm brass lantern glow", st) for k, v in dict(
 speaker="a wooden bluetooth speaker", phone="a modern smartphone", headphones="studio headphones", watch="a smartwatch with a brass tone",
 tablet="a tablet", laptop="a slim laptop", powerbank="a power bank", earbuds="wireless earbuds and case").items()}
S['sb']['hero'] = pp("a wooden portable speaker glowing among hanging brass Egyptian lanterns in Khan el-Khalili", "dusk, deep green and brass", st)
st = "Apple-store-like showroom, soft grey table, minimal, electric blue accent light, premium product photography"
S['sc'] = {k: prod(v, "light grey background", st) for k, v in dict(
 phone="a modern smartphone", laptop="a slim laptop open", headphones="noise cancelling headphones", watch="a smartwatch", tablet="a tablet", earbuds="wireless earbuds with case").items()}
# ---- Jasmine
st = "old Alexandria pharmacy mood, amber glass, deep olive-brown background, warm light, apothecary product photography"
S['ja'] = {k: prod(v, "dark olive-brown wood surface", st) for k, v in dict(
 dropper="an amber glass serum dropper bottle", jar="an amber cream jar with natural ingredients", pump="a rose water amber bottle with rose petals", tube="a skincare tube with oats and honey",
 compact="a small tin of lip balm with honey", mask="a green clay mask jar").items()}
S['ja']['hero'] = pp("one amber glass dropper bottle surrounded by black seed, honey, rose petals and shea butter", "dark olive-brown wood", st)
st = "sunny bathroom shelf in Maadi, blush pink and raspberry palette, playful bright beauty photography"
S['jb'] = {k: prod(v, "blush pink background", st) for k, v in dict(
 lipstick="a raspberry lip tint tube", pump="a pink foaming cleanser pump bottle", jar="a pink moisturizer jar", dropper="a pink serum dropper bottle",
 mask="a pink sheet mask sachet", compact="a pink cream blush compact", tube="a concealer tube").items()}
S['jb']['hero'] = pp("raspberry lip tints and blush on a sunny pink bathroom shelf", "blush pink", st)
for i, d in enumerate(["young Egyptian woman with a hijab smiling, selfie style, pink wall", "young Egyptian woman with long dark hair applying lip tint, pink background",
                       "young Egyptian woman with curly hair holding a skincare jar, bright bathroom", "young Egyptian woman in a headscarf smiling, soft pink light", "young Egyptian woman with fresh clean skin, towel on hair, pink tiles"]):
    S['jb'][f'face{i}'] = pp(d, "bright and natural", "authentic user-generated style portrait photo")
st = "calm dermatology clinic, daylight, white tile, mint and aqua accents, clinical clean product photography"
S['jc'] = {k: prod(v, "white tile background with soft mint tone", st) for k, v in dict(
 pump="a white cleanser pump bottle", dropper="a white serum dropper bottle with mint accent", tube="a white sunscreen tube", jar="a white ceramide cream jar", mask="a hydrating mask sachet").items()}
S['jc']['hero'] = pp("three skincare bottles in a row: cleanser, serum, sunscreen, with mint water droplets", "white tile and pale aqua", st)
# ---- Lamma
st = "Friday lunch in Shubra, steam and colour, warm terracotta tones, appetising Egyptian home food photography"
food = dict(mahshi="a plate of Egyptian mahshi stuffed cabbage and vine leaves", tagine="an Egyptian clay tagine of okra with meat, steaming", kunafa="Egyptian konafa with cream in a round tray",
            sweets="Egyptian basbousa squares with almonds on a tray", bowl="Egyptian rice with vermicelli in a bowl")
S['la'] = {k: pp(v, "family table, terracotta ceramic", st) for k, v in food.items()}
S['la']['hero'] = pp("overhead Friday lunch table with mahshi, tagines, rice and molokhia, steam rising", "terracotta tablecloth", st)
S['la']['maker'] = pp("warm portrait of an Egyptian home cook woman in her fifties in a headscarf, smiling in her kitchen", "soft window light", "authentic documentary portrait photograph")
st = "Om Hassan's home kitchen, deep green and saffron tones, warm rustic Egyptian home cooking photography"
fd2 = dict(bowl="Egyptian fattah with rice and meat", mahshi="Egyptian stuffed vine leaves", feteer="layered Egyptian feteer meshaltet with honey", kunafa="Egyptian konafa with cream", pickles="a jar of Egyptian homemade pickles",
           sweets="Egyptian basbousa tray", tagine="Egyptian okra tagine")
S['lb'] = {k: pp(v, "rustic dark green wooden table", st) for k, v in fd2.items()}
S['lb']['face'] = pp("warm portrait of an Egyptian grandmother home cook in a white headscarf smiling, green kitchen behind her", "soft warm light", "authentic documentary portrait photograph")
st = "morning delivery crate, bright true white background, vivid colours, fresh market photography"
fm = dict(tomatoes="fresh Egyptian baladi tomatoes", herbs="a bunch of fresh parsley and coriander", fruit="fresh oranges and apples", crate="a crate of eggs, milk and cheese", feteer="Egyptian baladi bread loaves",
          pickles="jars of Egyptian pickles", bowl="a bowl of Egyptian rice and lentils", sweets="Egyptian sweets in a box")
S['lc'] = {k: pp(v, "pure white background", st) for k, v in fm.items()}

# ---- Dahab A worn
st = "north window daylight on a white wall, macro jewellery photography on Egyptian skin, true white, soft shadow, warm 21 karat yellow gold"
S['da'] = {
 'hero': pp("extreme close-up of an Egyptian woman's hand wearing a slim 21 karat gold ring, fingers resting", "pure white background", st),
 'ring': pp("macro of a thin gold band ring worn on an Egyptian finger", "white background", st),
 'ring2': pp("macro of a gold signet ring worn on an Egyptian man's hand", "white background", st),
 'chain': pp("close-up of a fine gold chain necklace with a small pendant resting on an Egyptian woman's collarbone", "white blouse, white background", st),
 'bracelet': pp("close-up of a delicate gold bangle bracelet on an Egyptian wrist", "white background", st),
 'ear': pp("close-up of a small gold hoop earring on an Egyptian woman's ear, dark hair tucked back", "white background", st),
 'set': pp("close-up of an Egyptian woman's neck and ear wearing a matching gold necklace and drop earrings", "white background", st),
 'pendant': pp("macro of a small round gold pendant on a fine chain lying on an Egyptian neck", "white background", st)}
# ---- Dahab B workshop
st = "Fustat silversmith workshop, deep teal background, warm tungsten bench light, silver and turquoise, documentary craft photography"
S['db'] = {
 'hero': pp("close-up of weathered Egyptian silversmith hands hammering a silver ring on a small anvil", "dark teal workshop bench with tools", st),
 'maker': pp("portrait of an Egyptian silversmith man in his fifties with a grey moustache holding a loupe, in his workshop", "teal wall behind him", "authentic documentary portrait photograph"),
 'ring': pp("handmade silver ring set with a turquoise stone", "deep teal cloth", st),
 'cuff': pp("hand engraved silver cuff bracelet", "deep teal cloth", st),
 'pendant': pp("silver pendant with blue enamel and turquoise bead on a cord", "deep teal cloth", st),
 'earring': pp("pair of handmade silver drop earrings with turquoise", "deep teal cloth", st),
 'beads': pp("handmade silver and turquoise bead necklace", "deep teal cloth", st),
 'tools': pp("silversmith tools, small hammer, files and a flame torch on a wooden bench", "teal background", st)}
# ---- Dahab C gift box
st = "engagement-night gift, deep emerald green gift box with satin ribbon, blush pink tissue paper and gold jewellery, bright true white surface, soft studio light"
S['dc'] = {
 'hero': pp("a woman's hands opening an emerald gift box with a blush satin ribbon revealing a gold necklace", "white surface", st),
 'ring': pp("gold ring with a small stone in an open emerald ring box", "white surface, blush tissue", st),
 'necklace': pp("gold necklace with a heart pendant in an emerald gift box", "white surface, blush tissue", st),
 'bracelet': pp("a thin gold chain bracelet laid in a long curve across blush satin inside an open emerald gift box, clearly a bracelet, no rings", "white surface", st),
 'earring': pp("gold stud earrings in a small emerald box", "white surface, blush tissue", st),
 'set': pp("gold jewellery set in an emerald box with blush satin ribbon", "white surface", st),
 'box': pp("three emerald gift boxes stacked with blush and gold satin ribbons", "white background", st),
 'ribbon': pp("close-up of a blush satin ribbon tied in a bow on an emerald box", "white background", st)}
