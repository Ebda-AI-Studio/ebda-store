# Qamar demo assets: credits

All images and the hero clip in this folder are AI-generated illustrative samples (FLUX.1 schnell on
Cloudflare Workers AI, 2026-10-15; clip: ffmpeg zoompan over `hero-atelier.webp`, `make-video.sh`).
They are not a real merchant's products (Ruling TPL-3). Prompts: `prompts.py`. The storefront labels
them illustrative in the demo announcement bar ("الصور توضيحية / Illustrative photos").

Every file was read back (viewed) before commit; files with lettering, watermarks, a wrong garment or an
off-palette colour were regenerated (Ruling B1-9).

Regenerate: `python3 scripts/qamar-demo/gen.py` (needs `npx wrangler login`; skips files already in
`img-src/`), then `bash scripts/qamar-demo/encode.sh` and `bash scripts/qamar-demo/make-video.sh`.

- `look-1.webp`: scrawled marks on the wall at the right edge (B1-9 lettering class) retouched out on 2026-10-15 by cloning the plain wall 48px below (PIL, feathered mask), re-encoded WebP q80, 33,900 bytes; viewed back.
