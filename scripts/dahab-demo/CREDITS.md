# Dahab demo assets (Phase B5 Task 5)

The 24 WebP files in `assets/` are AI-generated ILLUSTRATIVE samples (Ruling TPL-3) for the `storedemo-dahab`
showroom: they are not a real jeweller's pieces and show no real brand, hallmark, person or place. They
replace the third-party stock photographs of the retired night + gold skin (that set, its fetch script and
its credits are removed in the same PR).

- **Model / how:** FLUX.1 schnell on Cloudflare Workers AI (`@cf/black-forest-labs/flux-1-schnell`, 8 steps),
  offline, by `gen.py` from the prompts in `prompts.py`; `grade.py` caps the saturation of gold-toned pixels
  (below); `encode.sh` crops (1:1 pieces, 4:3 sets, 16:9 heroes), caps the long edge at 1200 px and encodes
  with `cwebp` (each file <= 140 KB). No stock photo, no third-party image and no real person is used. The
  Workers AI call used the local wrangler login; nothing else was touched.
- **Unbranded (Ruling B5-11):** no logo, lettering, hallmark or readable engraving. FLUX invents text on any
  flat surface: a first pass of the gold bar came back stamped "UTINAL BULLION 2012", the chain sat on a
  slab with a printed caption and "13S7 Brillon", and the bridal set carried "butieley tionls." in a corner.
  All three were regenerated on plain grounds with prompts that name no word that implies a mark. Every file
  was viewed before commit (one contact sheet; the two regenerated pieces and the bar re-viewed alone).
- **No orange (Rulings B5-2, B5-11):** FLUX paints yellow gold at HSV saturation 0.5-0.8, which sits in the
  12-50 degree band the no-orange gate bans. Art direction answers it: the prompts ask for "pale champagne
  metal in cool neutral daylight on white and grey", and `grade.py` clamps every pixel in the band (11-51
  degrees) to saturation 0.30, so gold reads as pale gold, never as orange. `orange-probe.py` (hue 12-50,
  HSV saturation >= 0.35, value >= 0.15, every 3rd pixel) measured the worst file at 0.7 % against the 2 %
  limit; `tests/unit/dahab-demo-assets.test.ts` runs it with negative controls (orange, saffron, amber,
  terracotta fail) and a positive control (silver, white, emerald, champagne pass).
- **Faces and hands:** none. Skin reads as orange to the probe, so the "worn" shots are pieces on linen by a
  window, and the workshop hero shows tools and enamel dishes, not hands.
- **Merchant-style packshots:** the white-ground product shots are the same files, so quality-bar section 9
  rule 1 (a merchant photo on a white ground) is judged against real conditions.
- **Known illustrative limits:** the "gold" pieces are graded paler than real 21 karat gold on purpose; the
  gold bar is a plain plate and the coin a plain disc (any mark FLUX drew was a fake one); the single drop
  earring is one earring, not a pair.

## Hero re-render (Ruling HERO-HIRES-1, 2026-11-09)

The hero stills (`hero-*-2k.webp`) are 2048x1152 AI-generated illustrative samples: Cloudflare Workers AI FLUX.2 [dev] re-rendered the earlier 1024x576 still (kept as the reference image, same composition and palette), prompts in `prompts.py` plus the style line in `scripts/hero-hires/hires.py`. Hero budget <= 400 KB each. No stock photo, no real person, no third-party image.
