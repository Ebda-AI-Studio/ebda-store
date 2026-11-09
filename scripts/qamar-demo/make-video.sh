#!/usr/bin/env bash
# Ruling B1-10 (as amended by C18 and HERO-HIRES-1): a 6 s slow push-in over the 2K Atelier hero still,
# H.264, muted, faststart, no WebM; the poster is the still itself (hero-atelier-2k.webp). Two renditions:
# hero-1080.mp4 (1920x1080, <= 3 MB) and hero-540.mp4 (960x540, <= 1 MB) for phones (slide `videoMobile`).
# The still is upscaled 2x before zoompan so the push-in has no sub-pixel jitter.
set -euo pipefail
cd "$(dirname "$0")/assets"
mk() { # <out> <WxH> <crf> <max bytes>
  ffmpeg -hide_banner -loglevel error -y -loop 1 -i hero-atelier-2k.webp -t 6 -r 30 \
    -vf "scale=4096:-2,zoompan=z='min(zoom+0.0006,1.08)':d=180:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=$2:fps=30,format=yuv420p" \
    -an -c:v libx264 -preset slow -crf "$3" -movflags +faststart "$1"
  size=$(stat -f%z "$1"); echo "$1 $size bytes"
  [ "$size" -le "$4" ] || { echo "$1 is over $4 bytes"; exit 1; }
}
mk hero-1080.mp4 1920x1080 22 $((3 * 1024 * 1024))
mk hero-540.mp4 960x540 24 $((1 * 1024 * 1024))
