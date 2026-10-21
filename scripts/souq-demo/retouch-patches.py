# MANUAL, offline step: blur named rectangles out of a generated image (shop-sign lettering and a
# stray red highlight in hero-night, Ruling B2-10: no lettering anywhere). Usage:
#   uv run --with pillow python retouch-patches.py img-src/hero-night.jpg x0,y0,x1,y1 [x0,y0,x1,y1 ...]
import sys
from PIL import Image, ImageFilter
path = sys.argv[1]
im = Image.open(path).convert('RGB')
for spec in sys.argv[2:]:
    x0, y0, x1, y1 = map(int, spec.split(','))
    pad = 10
    region = im.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad)).filter(ImageFilter.GaussianBlur(14))
    im.paste(region.crop((pad, pad, pad + x1 - x0, pad + y1 - y0)), (x0, y0))
im.save(path, quality=92)
print('patched', len(sys.argv) - 2, 'areas in', path)
