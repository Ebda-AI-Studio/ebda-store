# Souq demo assets: credits

All images in this folder are AI-generated ILLUSTRATIVE samples (FLUX.1 schnell on Cloudflare Workers
AI, 2026-10-21). They are not a real merchant's products (Ruling TPL-3) and carry no brand (Ruling
B2-10): devices are dark and abstract, no logos, no lettering, no readable screens. Prompts:
`prompts.py`. The storefront labels them illustrative in the demo announcement bar.

Every file was viewed before commit; files with lettering, a brand mark, an orange or warm-yellow
cast or a wrong product were regenerated (up to four rounds). `orange-probe.py` measures the share of
orange pixels (hue 12-50, saturation >= 0.35, value >= 0.25): every file is <= 3 %, heroes <= 5 %
(`tests/unit/souq-demo-assets.test.ts`). 21 files, 256 KB in total, none over 140 KB.

Regenerate: `python3 scripts/souq-demo/gen.py` (needs a valid wrangler OAuth token: run
`npx wrangler whoami` in `apps/api` to refresh it; skips files already in `img-src/`), then
`bash scripts/souq-demo/encode.sh`, then `python3 scripts/souq-demo/orange-probe.py scripts/souq-demo/assets/*.webp`.

Manual retouches (PIL, offline; recorded here because the committed WebP is not the raw generation):

- `hero-night.webp`: the raw lantern hero measured 11.6 % orange (shop lights). `retouch.py` shifted every
  warm pixel to jade (hue 165), and `retouch-patches.py` blurred out four rectangles (two shop-sign
  lettering fragments, one stray red highlight, one more sign) in the 1024x1024 source before the 16:9 crop.
  STOP-1 replaced the earlier device-slab composition: the prompt now asks for an empty arcade (no objects,
  devices, people or signs), so there are no dark slabs. Probe after: 0.0 %.
- `washing-machine.webp`: the raw front view carried micro-lettering on the control panel in all four
  generations; the source was cropped (135,250 to 909,1024) to the door and drum, which has none.
- `student-laptop.webp`: a closed lid (no keyboard): every open-laptop generation printed letters on the keys.
- `kettle.webp` replaced the espresso machine of the first catalogue draft (every generation printed a
  badge or lettering on the front).
- `tv-43.webp`, `tv-55.webp`: third-round generations with a plain bezel (the first two printed a brand strip).

## Hero re-render (Ruling HERO-HIRES-1, 2026-11-09)

The hero stills (`hero-*-2k.webp`) are 2048x1152 AI-generated illustrative samples: Cloudflare Workers AI FLUX.2 [dev] re-rendered the earlier 1024x576 still (kept as the reference image, same composition and palette), prompts in `prompts.py` plus the style line in `scripts/hero-hires/hires.py`. Hero budget <= 400 KB each. No stock photo, no real person, no third-party image.
