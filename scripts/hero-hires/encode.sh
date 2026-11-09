#!/usr/bin/env bash
# img-src/<template>-<name>.jpg (hires.py output, 2048x1152, gitignored) -> <template>-demo/assets/<name>-2k.webp,
# cwebp q82 (-sharp_yuv); over the 400 KB hero budget -> q76, then q70; still over -> fail.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; fail=0
for f in "$here"/img-src/*.jpg; do
  b=$(basename "$f" .jpg); tpl=${b%%-*}; name=${b#*-}; out="$here/../$tpl-demo/assets/$name-2k.webp"
  for q in 82 76 70; do
    cwebp -quiet -q "$q" -m 6 -sharp_yuv -metadata none "$f" -o "$out"
    [ "$(stat -f%z "$out")" -le $((400 * 1024)) ] && break
  done
  s=$(stat -f%z "$out"); [ "$s" -le $((400 * 1024)) ] && echo "ok $name-2k.webp $s" || { echo "OVER $name-2k.webp $s"; fail=1; }
done
exit $fail
