# Prompts for the Lamma demo catalogue (B4 Task 6). AI-generated ILLUSTRATIVE samples (Ruling TPL-3,
# B4-11): not a real kitchen's food. One prompt per output file; gen.py writes img-src/<name>.jpg and
# encode.sh crops/encodes it to assets/<name>.webp. `C` names the aspect each file is cut to.
# Rules (Rulings B4-2, B4-3, B4-11): no logos, brand marks, lettering or readable labels (FLUX invents
# text: packaging is plain and blank, bread bags and boxes carry nothing, and no prompt words describe
# text or layout, since FLUX paints them: 'breathing room' came back as lettering); no orange SUBJECT
# (oranges, carrots, mango, pumpkin, orange sauce): FLUX reads a negated food or colour word as a
# positive one (a 'no oranges' prompt painted oranges), so the prompts only NAME the colours wanted
# and food is photographed in cool-neutral daylight so browns, creams and greens stay what they are. Every output is viewed
# before commit and probed by orange-probe.py (the food-calibrated probe, Ruling B4-3).
NEG = ("plain unprinted surfaces, blank unmarked packaging, no people, no face")
LIGHT = "soft cool neutral daylight, sharp realistic food photograph"
DISH_GROUND = "on a pale grey linen cloth, shot from slightly above, the dish fills most of the frame"
CUT_GROUND = "on a clean seamless white to pale grey studio ground, soft diffuse shadow under it, one subject centered"


def dish(subject, extra=""):
    return f"{subject}, {DISH_GROUND}, {LIGHT}, {extra} {NEG}".replace("  ", " ").strip()


def cut(subject, extra=""):
    return f"{subject}, {CUT_GROUND}, {LIGHT}, {extra} {NEG}".replace("  ", " ").strip()


P = {}
C = {}  # name -> crop: 'dish' (4:3 food), 'square' (1:1 cut-outs) or 'wide' (16:9 hero)


def add(name, prompt, crop):
    P[name] = prompt
    C[name] = crop


# ---- stuffed and home cooking
add('mahshi-koronb', dish("a round white plate of Egyptian stuffed cabbage rolls, many small tight cylinders of cooked dark green cabbage leaf, each rolled around rice, one cut open showing white rice inside, glossy olive green rolls in a shallow pale brown broth, a few sprigs of fresh parsley, white plate and olive green only"), 'dish')
add('waraq-enab', dish("a white plate of thin tightly rolled stuffed vine leaves in dark green, neatly stacked in a pile, nothing else on the plate, dark green and white only"), 'dish')
add('lentil-soup', dish("a white bowl of smooth creamy pale beige lentil soup with a drizzle of green olive oil, a plain spoon beside the bowl, beige and white only"), 'dish')
# ---- tagines
add('okra-tagine', dish("a wide round dark clay pot filling most of the frame, okra and beef stew in a dark brown garlic and coriander sauce, only green okra pods and dark brown beef cubes and fresh green coriander, dark brown and green tones only"), 'dish')
add('bechamel-pasta', dish("a rectangular white baking dish of baked pasta covered in thick white bechamel with a pale beige top, one square portion lifted out showing white bechamel and dark brown minced meat layers, the dish fills the frame, white pale beige and dark brown only"), 'dish')
add('molokhia-chicken', dish("a white bowl of dark green molokhia soup with pieces of white roast chicken, a small bowl of white rice beside it, dark green and white only"), 'dish')
# ---- grill and bakery
add('kofta-grilled', dish("a round plate of grilled beef kofta fingers charred dark brown with grilled green peppers and white onion rings, the plate fills the frame, dark brown green and white only"), 'dish')
add('baladi-bread', dish("a stack of five round flat whole wheat baladi breads with a dusting of bran, in a plain paper bag with no printing, brown and beige tones"), 'dish')
# ---- sweets
add('basbousa-qishta', dish("six pale ivory diamond pieces of basbousa each topped with thick white cream and a white almond, on a white plate, the plate fills the frame, ivory and white only"), 'dish')
add('kunafa-nabulsi', dish("a round tray of kunafa with a crisp pale golden brown top and white cheese layer showing at the cut, pistachio crumbs on top, beige and cream and green tones"), 'dish')
add('kahk-eid', dish("a plain white gift box full of round kahk biscuits completely covered in white powdered sugar, pure white and pale ivory tones, a few biscuits beside the box"), 'dish')
add('chocolate-cake', dish("a tall round dark chocolate cake with glossy chocolate ganache and a plain white writing area on top, one slice cut out, deep brown tones"), 'dish')
# ---- fruit and vegetables (cut-outs on white, no orange subject)
add('tomatoes', cut("a small pile of round deep red ripe tomatoes with green stems"), 'square')
add('cucumbers', cut("three long green cucumbers, one cut into slices, bright green and pale green tones"), 'square')
add('arugula', cut("a loose tied bunch of fresh green arugula leaves with a plain string, bright green"), 'square')
add('eggplant', cut("two glossy deep purple eggplants with green caps, one halved showing pale cream flesh"), 'square')
add('green-pepper', cut("a small pile of bright green peppers with stems"), 'square')
add('potatoes', cut("a small pile of clean light brown potatoes with pale beige skin"), 'square')
add('apples', cut("a small pile of bright green granny smith apples with short stems, uniformly green"), 'square')
# ---- dairy
add('rumi-cheese', cut("a wedge of pale cream hard rumi cheese on a small white board beside a cheese knife, ivory and white tones"), 'square')
add('fresh-milk', cut("a single clear glass bottle of white milk with a plain white cap, only the bottle, white and clear glass only"), 'square')
add('baladi-yogurt', cut("a plain unglazed pale clay pot of thick white yogurt with a spoon, white and beige tones"), 'square')
# ---- meat
add('whole-chicken', cut("a raw whole plucked chicken, pale pink skin, on a plain white plate, pink and white tones"), 'square')
add('minced-beef', cut("a mound of fresh raw minced beef on a plain white plate, deep red and white tones"), 'square')
# ---- pantry
add('egyptian-rice', cut("a plain unmarked white paper bag of rice standing next to a small bowl of white rice grains, white and cream tones"), 'square')
add('brown-lentils', cut("a white bowl heaped with whole dark olive brown lentils beside a plain kraft paper bag, olive brown and cream tones"), 'square')
add('black-tea', cut("a plain unmarked small dark green tin with a lid beside a white cup of dark brewed black tea and loose dry tea leaves, deep green and dark brown tones"), 'square')
add('cooking-oil', cut("a single clear glass bottle of pale golden vegetable oil with a plain white cap, only the bottle, clear glass and pale yellow only"), 'square')  # the no-photo edge case lives in the lamma-noimg scenario store
# ---- hero (16:9) and the maker
add('hero-table', ("a Friday table spread seen from above on white linen: round clay and white ceramic dishes of stuffed vine leaves, "
                   "a pot of dark green molokhia, white rice, a bowl of fresh green salad and a basket of flat bread, with sprigs of dill, "
                   "red clay serving dishes, a few small red pomegranate seeds in a bowl, cool soft daylight, calm empty space on the left, "
                   "cinematic food photograph, cool palette of white, green, brown and deep red, " + NEG), 'wide')
add('maker', dish("a pair of floured hands rolling a stuffed dark green vine leaf on a pale wooden board, a stack of green leaves beside them, close crop on the hands and the board only, soft cool daylight, sharp realistic photograph"), 'square')
