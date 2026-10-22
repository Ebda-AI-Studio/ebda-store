# MANUAL, offline step, run after gen.py and before encode.sh: grades gold-toned metal to a PALE champagne
# (Ruling B5-11). Yellow gold photographs at HSV saturation 0.5-0.8 in the 12-50 degree hue band, which is
# the band the no-orange gate bans (Ahmad 2026-10-16). Art direction answers it: every pixel in that band is
# capped at saturation 0.30, so a ring reads as pale gold / champagne on its cool ground and never as
# orange. Idempotent (clamping a clamped pixel changes nothing). Run:
#   uv run --with pillow --with numpy python grade.py [name ...]
import os, sys
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, 'img-src')
CAP = 0.30
only = set(sys.argv[1:])
for fn in sorted(os.listdir(IMG)):
    if not fn.endswith('.jpg') or (only and fn[:-4] not in only):
        continue
    path = os.path.join(IMG, fn)
    hsv = np.array(Image.open(path).convert('RGB').convert('HSV'), dtype=np.float32)
    h, s = hsv[..., 0], hsv[..., 1]
    # PIL HSV is 0-255 per channel: hue degrees = h / 255 * 360. Band 11-51 degrees (a 1-degree guard each side).
    band = (h >= 11 / 360 * 255) & (h <= 51 / 360 * 255)
    over = band & (s > CAP * 255)
    if over.any():
        hsv[..., 1] = np.where(over, CAP * 255, s)
        Image.fromarray(hsv.astype(np.uint8), 'HSV').convert('RGB').save(path, quality=93)
    print(fn, f'graded {over.mean():.3f}' if over.any() else 'ok', flush=True)
