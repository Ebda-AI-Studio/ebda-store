# MANUAL, offline step: shift every warm (orange/amber, hue 5-60) pixel of a generated image to jade
# (hue 165) keeping saturation and value, so a lantern-lit hero stays in the Souq palette (Ruling B2-2).
# Usage: uv run --with pillow --with numpy python retouch.py img-src/hero-night.jpg
import sys
import numpy as np
from PIL import Image
path = sys.argv[1]
im = Image.open(path).convert('RGB')
hsv = np.array(im.convert('HSV'), dtype=np.float32)
h = hsv[..., 0] * 360 / 255.0
warm = (h >= 5) & (h <= 60) & (hsv[..., 1] / 255.0 >= 0.2)
hsv[..., 0] = np.where(warm, 165 * 255 / 360.0, hsv[..., 0])
Image.fromarray(hsv.astype(np.uint8), 'HSV').convert('RGB').save(path, quality=92)
print('retouched', path, 'warm px share', round(float(warm.mean()), 4))
