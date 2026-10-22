#!/usr/bin/env python3
"""Page-wide orange probe for RENDERED SHOTS (Phase B4 Task 6, Review Focus 1, Ruling B4-3).

orange-probe.py guards the generated PHOTOS (<= 4 % / 6 %). This one guards the rendered pages with
the SAME food-calibrated definition (Ruling B4-3): the share of pixels with hue 12-45 degrees, HSV
saturation >= 0.65 and value >= 0.60 over a whole screenshot must stay <= 6 %. Bread, crust and
caramel are lower in saturation or value and pass; a glowing orange does not. The Notebook brass is
the scoped metal exception (Ruling B4-2) and sits below the saturation floor.

  uv run --with pillow python scripts/lamma-demo/shot-orange-probe.py <png> [<png> ...]
  uv run --with pillow python scripts/lamma-demo/shot-orange-probe.py --self-test   # negative control

exit 0 = every file within the limit, 1 = a file is over it, 2 = a file could not be read.
"""
import json, os, sys

HUE_MIN, HUE_MAX, SAT_MIN, VAL_MIN = 12.0, 45.0, 0.65, 0.60
LIMIT, STRIDE = 0.06, 2


def share(img):
    img = img.convert('RGB')
    w, h = img.size
    px = img.load()
    hit = total = 0
    for y in range(0, h, STRIDE):
        for x in range(0, w, STRIDE):
            r, g, b = px[x, y]
            total += 1
            mx, mn = max(r, g, b), min(r, g, b)
            if mx == 0 or mx == mn:
                continue
            v, s = mx / 255.0, (mx - mn) / mx
            if v < VAL_MIN or s < SAT_MIN:
                continue
            d = mx - mn
            if mx == r:
                hue = ((g - b) / d) % 6
            elif mx == g:
                hue = (b - r) / d + 2
            else:
                hue = (r - g) / d + 4
            hue *= 60.0
            if HUE_MIN <= hue <= HUE_MAX:
                hit += 1
    return hit / total if total else 0.0


def self_test():
    from PIL import Image
    orange = Image.new('RGB', (60, 60), (230, 130, 69))
    brass_page = Image.new('RGB', (60, 60), (36, 41, 28))
    for x in range(60):
        for y in range(2):
            brass_page.putpixel((x, y), (200, 155, 60))  # a thin brass bar: under the limit
    clean = Image.new('RGB', (60, 60), (246, 215, 220))
    ok = share(orange) > LIMIT and share(clean) <= LIMIT and share(brass_page) <= LIMIT
    print(json.dumps({'self_test': ok, 'orange': share(orange), 'brass_bar': share(brass_page), 'clean': share(clean)}))
    return 0 if ok else 1


def main(argv):
    if argv[:1] == ['--self-test']:
        return self_test()
    from PIL import Image
    code = 0
    for path in argv:
        try:
            s = share(Image.open(path))
        except Exception as e:  # unreadable: fail loudly, never pass
            print(json.dumps({'file': os.path.basename(path), 'error': str(e)}))
            code = max(code, 2)
            continue
        ok = s <= LIMIT
        print(json.dumps({'file': os.path.basename(path), 'share': round(s, 4), 'limit': LIMIT, 'ok': ok}))
        if not ok:
            code = max(code, 1)
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
