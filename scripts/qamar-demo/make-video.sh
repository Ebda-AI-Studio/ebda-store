#!/usr/bin/env bash
# Ruling B1-10 (as amended by C18): a 6 s slow push-in over the Atelier hero still, one MP4
# (H.264, muted, faststart), no WebM; the poster is the still itself (hero-atelier.webp).
set -euo pipefail
cd "$(dirname "$0")/assets"
ffmpeg -hide_banner -loglevel error -y -loop 1 -i hero-atelier.webp -t 6 -r 30 \
  -vf "scale=2560:-2,zoompan=z='min(zoom+0.0006,1.08)':d=180:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720:fps=30,format=yuv420p" \
  -an -c:v libx264 -preset slow -crf 28 -movflags +faststart hero.mp4
size=$(stat -f%z hero.mp4)
echo "hero.mp4 $size bytes"
[ "$size" -le $((1536 * 1024)) ] || { echo "hero.mp4 is over 1.5 MB"; exit 1; }
