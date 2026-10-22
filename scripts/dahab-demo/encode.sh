#!/usr/bin/env bash
# img-src/*.jpg (gen.py output, gitignored) -> assets/*.webp within the byte budget (Ruling B4-11):
# dishes 4:3, grocery cut-outs square, the hero 16:9, long edge capped at 1200 px (never upscaled),
# cwebp -q 72; over 140 KB -> re-encode at -q 64, then -q 56; still over -> fail.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/img-src"; out="$here/assets"; tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"
max=$((140 * 1024))
crops="$(cd "$here" && python3 -c 'from prompts import C; print("\n".join(f"{k} {v}" for k, v in C.items()))')"
fail=0
while read -r name crop; do
  [ -f "$src/$name.jpg" ] || { echo "missing $name.jpg"; fail=1; continue; }
  w=$(sips -g pixelWidth "$src/$name.jpg" | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight "$src/$name.jpg" | awk '/pixelHeight/{print $2}')
  case "$crop" in
    square) s=$(( w < h ? w : h )); cw=$s; ch=$s ;;
    dish) cw=$w; ch=$(( w * 3 / 4 )); [ "$ch" -gt "$h" ] && { ch=$h; cw=$(( h * 4 / 3 )); } ;;
    wide) cw=$w; ch=$(( w * 9 / 16 )); [ "$ch" -gt "$h" ] && { ch=$h; cw=$(( h * 16 / 9 )); } ;;
    *) cw=$w; ch=$h ;;
  esac
  sips -c "$ch" "$cw" "$src/$name.jpg" --out "$tmp/$name.jpg" >/dev/null
  if [ "$cw" -gt 1200 ] || [ "$ch" -gt 1200 ]; then sips -Z 1200 "$tmp/$name.jpg" >/dev/null; fi
  for q in 72 64 56; do
    cwebp -quiet -q "$q" -m 6 -metadata none "$tmp/$name.jpg" -o "$out/$name.webp"
    [ "$(stat -f%z "$out/$name.webp")" -le "$max" ] && break
  done
  size=$(stat -f%z "$out/$name.webp")
  if [ "$size" -gt "$max" ]; then echo "OVER $name.webp $size"; fail=1; else echo "ok $name.webp ${cw}x${ch} $size"; fi
done <<< "$crops"
exit "$fail"
