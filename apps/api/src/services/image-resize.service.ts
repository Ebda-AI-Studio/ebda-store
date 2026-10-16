/**
 * Target dimensions per aspect ratio. Picked to match the storefront's
 * sizing-contract defaults (see store-layout.ts + 2026-05-16-mobile-ui-
 * ship.md) and provide enough resolution for Retina displays.
 *
 * Keep these large enough that resizing DOWN happens (sharp upscales
 * poorly). 1200×800 hero @ 3:2 covers a 600×400 CSS-px hero at 2x DPR.
 */
export const ASPECT_TARGETS: Record<string, { w: number; h: number }> = {
  '3:2': { w: 1200, h: 800 }, // legacy hero desktop
  '1:1': { w: 1000, h: 1000 }, // category + product
  // 3:4 was hero mobile portrait — DEPRECATED 2026-05-18 (Ahmad: mobile
  // hero must be landscape). Kept for product/category portrait crops.
  '3:4': { w: 600, h: 800 },
  '16:9': { w: 1280, h: 720 }, // alternative hero
  '4:3': { w: 1200, h: 900 }, // alternative hero
  '2:3': { w: 800, h: 1200 }, // alternative category
  '2.45:1': { w: 1470, h: 600 }, // wide-cinema hero (legacy)
  // Canonical hero desktop per packages/shared/src/types/image-standards.ts.
  '1920:700': { w: 1920, h: 700 }, // hero desktop (all themes inherit or override)
  // Hero mobile 16:9 standard (Ahmad 2026-06-03): supersedes 1080×394.
  // '1080:394' kept for legacy uploaded assets that may still reference it;
  // new uploads target '1200:675'. The '16:9' key above (1280×720) is
  // a close proxy — '1200:675' is the precise key for the new standard.
  '1200:675': { w: 1200, h: 675 }, // hero mobile 16:9 (trial)
  '1200:900': { w: 1200, h: 900 }, // hero mobile 4:3 (canonical from 2026-06-03)
  '1080:394': { w: 1080, h: 394 }, // hero mobile legacy (superseded — kept for old assets)
};

/**
 * Upload-time size ceiling (historically 2000px on the longest side) — WHY IT EXISTED: on
 * 2026-05-01 the demo-boutique catalog went up as 19 images averaging 8 MB (a 4160x6240 PNG at
 * 28 MB) and shipped that to every mobile customer until 2026-08-09. On Workers, where the API
 * runs, `sharp` never loaded, so production has stored originals since the Workers move; the
 * Node-only resize that tests exercised was never the production path (Ruling FU46-8). The
 * ceiling must come back at delivery (Cloudflare Images), not in this function.
 */
export async function enforceMaxDimensions(buffer: Buffer): Promise<Buffer> {
  // Ruling FU46-8: no `sharp` anywhere in the API — it cannot load on workerd, where
  // production runs and where this already returned the original. The ceiling therefore
  // belongs to delivery (Cloudflare Images `/cdn-cgi/image/...` or the IMAGES binding), which is
  // NOT wired yet: until it is, every runtime stores the original as sent (≤ 10 MB, the upload
  // cap). Kept as a function so every upload route keeps one call site to switch on later.
  return buffer;
}

/**
 * Same as `enforceMaxDimensions`: the aspect crop moves to delivery (Ruling FU46-8), so the
 * original is returned on every runtime. `ASPECT_TARGETS` stays the shared size table.
 */
export async function resizeToAspect(buffer: Buffer, _aspect: string | undefined): Promise<Buffer> {
  return buffer;
}
