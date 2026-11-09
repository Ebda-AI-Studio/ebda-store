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
- `look-1.webp`, `look-2.webp`, `look-3.webp`: regenerated on 2026-10-16 (W2a, quality bar LB-04) with prompts that name every piece their shop-the-look panel lists, front view: look-1 rose linen abaya + burgundy chiffon scarf + gold silk shawl; look-2 teal satin midi dress + open black abaya + gold silk shawl; look-3 embroidered ivory kaftan + open black abaya + brown cotton headscarf (best of three tries; the first look-3 missed the abaya). The round-1 back views and the retouched look-1 are replaced. All three viewed back: front views, every listed piece visible, no lettering or signage.

## Hero re-render (Ruling HERO-HIRES-1, 2026-11-09)

The hero stills (`hero-*-2k.webp`, `lookbook-*-2k.webp`, `hero-1080.mp4`, `hero-540.mp4`) are 2048x1152 AI-generated illustrative samples: Cloudflare Workers AI FLUX.2 [dev] re-rendered the earlier 1024x576 still (kept as the reference image, same composition and palette), prompts in `prompts.py` plus the style line in `scripts/hero-hires/hires.py`. Hero budget <= 400 KB each. No stock photo, no real person, no third-party image.
