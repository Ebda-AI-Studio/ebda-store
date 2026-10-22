#!/usr/bin/env python3
"""Food-calibrated orange-pixel probe (Rulings B2-2, B4-3): no orange in a Lamma asset.

Bread, tagines and kunafa are brown and gold by nature, so Souq's strict probe (hue 12-50, HSV
saturation >= 0.35) would reject any loaf. This one counts a pixel as orange when its hue is
12-45 degrees AND its HSV saturation is >= 0.65 AND its value is >= 0.60: crust, caramel, brown
sauce and golden-brown tops (lower saturation or value) pass; a glowing orange (oranges, carrots,
a lantern, an orange sauce) fails. Limits: <= 4 % of the pixels per product / category image,
<= 6 % per hero (file name starts with `hero`). Pure standard library: .webp is decoded with
`dwebp -ppm` (brew install webp), .ppm (P6) is read directly (the test's negative control writes an
orange one). Every 3rd pixel in each direction is sampled.

  python3 orange-probe.py assets/*.webp          # prints one JSON object per file
  exit 0 = all within limit, 1 = a file is over its limit, 2 = a file could not be decoded
"""
import json, os, subprocess, sys, tempfile

HUE_MIN, HUE_MAX, SAT_MIN, VAL_MIN = 12.0, 45.0, 0.65, 0.60
LIMIT, HERO_LIMIT, STRIDE = 0.04, 0.06, 3


def read_ppm(path):
    with open(path, 'rb') as f:
        data = f.read()
    # header: P6 <w> <h> <max>, whitespace separated, then raw bytes
    pos, fields = 2, []
    assert data[:2] == b'P6', 'not a P6 ppm'
    while len(fields) < 3:
        while data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b'#':
            while data[pos:pos + 1] != b'\n':
                pos += 1
            continue
        start = pos
        while not data[pos:pos + 1].isspace():
            pos += 1
        fields.append(int(data[start:pos]))
    pos += 1
    w, h, _ = fields
    return w, h, data[pos:pos + w * h * 3]


def load(path):
    if path.endswith('.ppm'):
        return read_ppm(path)
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, 'x.ppm')
        subprocess.run(['dwebp', '-quiet', '-ppm', path, '-o', out], check=True)
        return read_ppm(out)


def is_orange(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == 0 or mx == mn:
        return False
    v, s = mx / 255.0, (mx - mn) / mx
    if v < VAL_MIN or s < SAT_MIN:
        return False
    d = mx - mn
    if mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    h *= 60.0
    return HUE_MIN <= h <= HUE_MAX


def share(path):
    w, h, px = load(path)
    hit = total = 0
    for y in range(0, h, STRIDE):
        row = y * w * 3
        for x in range(0, w, STRIDE):
            i = row + x * 3
            total += 1
            if is_orange(px[i], px[i + 1], px[i + 2]):
                hit += 1
    return hit / total if total else 0.0


def main(argv):
    code = 0
    for path in argv:
        try:
            s = share(path)
        except Exception as e:  # undecodable file: fail loudly, never pass
            print(json.dumps({'file': path, 'error': str(e)}))
            code = max(code, 2)
            continue
        limit = HERO_LIMIT if os.path.basename(path).startswith('hero') else LIMIT
        ok = s <= limit
        print(json.dumps({'file': os.path.basename(path), 'share': round(s, 4), 'limit': limit, 'ok': ok}))
        if not ok:
            code = max(code, 1)
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
