# MANUAL, offline step (STOP-2 taste audit, Night hero): the jade-graded lanterns read as neon
# teal against Night's brass CTA. Regrade the bright lantern glow to pale CHAMPAGNE brass: hue 42 at
# saturation <= 0.28, which sits UNDER the orange gate (hue 12-50 only counts from saturation 0.35),
# so the warmth is metallic, never amber. The stone arcade keeps its green. The probe is the gate.
# Usage: uv run --with pillow --with numpy python regrade-champagne.py img-src/hero-night.teal.jpg img-src/hero-night.jpg
import sys
import numpy as np
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
hsv = np.array(im.convert('HSV'), dtype=np.float32)
h = hsv[..., 0] * 360 / 255.0
s = hsv[..., 1] / 255.0
v = hsv[..., 2] / 255.0
teal = (h >= 130) & (h <= 210) & (s >= 0.2)
glow = teal & (v >= 0.6)
halo = teal & (v >= 0.35) & (v < 0.6)
hh = np.where(glow | halo, 42.0, h)
ss = np.where(glow, np.minimum(s * 0.45, 0.28), np.where(halo, np.minimum(s * 0.5, 0.26), s))
vv = np.where(glow, np.minimum(v * 1.06, 1.0), v)
out = np.stack([hh * 255 / 360.0, ss * 255, vv * 255], axis=-1).astype(np.uint8)
Image.fromarray(out, 'HSV').convert('RGB').save(dst, quality=92)
print('regraded', dst, 'glow share', round(float(glow.mean()), 4), 'halo share', round(float(halo.mean()), 4))
