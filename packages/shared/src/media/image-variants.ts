/**
 * Pre-generated image width variants (docs/RULINGS.md PERF-STORE-3).
 *
 * The storefront used to ship every product / hero / category photo at the size
 * it was stored (up to 2000 px) into a 180 px card slot: Cloudflare Image
 * Transformations are not enabled on the ebda.app zone (probed 2026-10-08:
 * `https://media.ebda.app/cdn-cgi/image/...` answers 404) and `next/image` runs
 * `unoptimized` on Workers. So the upload pipeline writes a small WIDTH LADDER
 * next to every raster original, and the storefront image loader picks the
 * smallest rung that covers the requested width.
 *
 * Naming is the whole contract and is derived, never stored:
 *
 *     stores/<storeId>/products/<uuid>-name.jpg            original (unchanged)
 *     stores/<storeId>/products/<uuid>-name.jpg.w720.webp  variant, 720 px wide
 *
 * The suffix is appended to the FULL original key (extension included), so
 *  - a variant maps back to its original by stripping `.w<N>.webp`;
 *  - `deleteByPrefix(stores/<id>/)` (store erasure) removes variants for free;
 *  - the original's URL is never rewritten and no DB column is needed.
 *
 * Every rung always exists for an eligible original: a source narrower than the
 * rung is copied at its own width (sharp `withoutEnlargement`), so the loader
 * never has to know the intrinsic width.
 *
 * Pure string helpers only — shared by the API (write/delete/sweep) and the web
 * loader (read), so they cannot drift.
 */

/**
 * Variant widths in device pixels, ascending, picked against the slots the
 * storefront actually has (CSS px x device pixel ratio):
 *   480   two-column mobile card ~206 px x 1.75-2.25, 60vw carousel card ~247 x 1.75, desktop 25vw card x 1
 *   720   full-width phone hero 412 x 1.75, desktop card x 2
 *   960   full-width phone hero 412 x 2.25, tablet
 *   1280  desktop PDP / half-width image x 2, desktop hero x 1
 * Anything wider (a 1440+ CSS px hero at DPR 2) is served the original.
 * (A first ladder of 360 / 720 / 1080 / 1440 sat just under Lighthouse's
 * DPR 1.75 x 206 px = 361 and tripled card bytes; 420 / 840 / 1260 missed the
 * 247 px carousel card at 1.75 = 432.)
 */
export const IMAGE_VARIANT_WIDTHS = [480, 720, 960, 1280] as const;
export type ImageVariantWidth = (typeof IMAGE_VARIANT_WIDTHS)[number];

/** Raster formats that get variants. SVG / GIF (animation) / AVIF / video are left alone. */
const ELIGIBLE_EXT = /\.(jpe?g|png|webp)$/i;
const VARIANT_SUFFIX = /\.w(\d{2,4})\.webp$/i;

/** `<key>.w640.webp` */
export function variantKey(originalKey: string, width: number): string {
  return `${originalKey}.w${width}.webp`;
}

/** Every variant key for an original, ascending. */
export function variantKeysFor(originalKey: string): string[] {
  return IMAGE_VARIANT_WIDTHS.map(w => variantKey(originalKey, w));
}

/** True when `key` is itself a generated variant (never an original). */
export function isVariantKey(key: string): boolean {
  const m = VARIANT_SUFFIX.exec(key);
  if (!m) return false;
  const w = Number(m[1]);
  // The base must itself look like an eligible original: `a.jpg.w640.webp` is a
  // variant, but `photo.w640.webp` (a merchant file literally named that) is an
  // original whose own variants would be `photo.w640.webp.w640.webp`.
  return (IMAGE_VARIANT_WIDTHS as readonly number[]).includes(w) && ELIGIBLE_EXT.test(key.slice(0, m.index));
}

/** The original key a variant was made from, or null if `key` is not a variant. */
export function baseKeyOfVariant(key: string): string | null {
  return isVariantKey(key) ? key.replace(VARIANT_SUFFIX, '') : null;
}

/** Does this original get variants? (extension check only; the API also checks the bytes.) */
export function isVariantEligibleKey(key: string): boolean {
  return ELIGIBLE_EXT.test(key) && !isVariantKey(key);
}

/** Smallest rung >= the requested width; null when the original itself is the right size. */
export function pickVariantWidth(requested: number): ImageVariantWidth | null {
  if (!Number.isFinite(requested) || requested <= 0) return null;
  for (const w of IMAGE_VARIANT_WIDTHS) if (w >= requested) return w;
  return null;
}

/** Hostnames whose objects the upload pipeline writes (the public R2 bucket). */
export function isVariantHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'media.ebda.app' || h.endsWith('.r2.dev');
}

/**
 * The variant URL for `originalUrl` at (at least) `requestedWidth`, or the
 * original URL when no variant applies (foreign host, non-raster, already a
 * variant, width above the top rung, unparsable). Never throws.
 */
export function imageVariantUrl(originalUrl: string, requestedWidth: number): string {
  try {
    const rung = pickVariantWidth(requestedWidth);
    if (rung === null) return originalUrl;
    const u = new URL(originalUrl);
    if (u.protocol !== 'https:' || !isVariantHost(u.hostname)) return originalUrl;
    if (u.search || u.hash) return originalUrl;
    if (!isVariantEligibleKey(u.pathname)) return originalUrl;
    u.pathname = variantKey(u.pathname, rung);
    return u.toString();
  } catch {
    return originalUrl;
  }
}

/**
 * Width the ORIGINAL is advertised at in a `srcset` / in `next.config.js`
 * `images.deviceSizes`. Uploads are capped at 2000 px on the longest side
 * (`enforceMaxDimensions`), so the original is the "big screen" candidate; its
 * true width is unknown to a pure string helper, 1920 is the hero standard.
 */
export const IMAGE_ORIGINAL_SRCSET_WIDTH = 1920;

/**
 * `srcset` string over the whole ladder plus the original as the largest
 * candidate (width descriptors), or '' when no variant applies.
 */
export function imageVariantSrcSet(originalUrl: string): string {
  const first = imageVariantUrl(originalUrl, IMAGE_VARIANT_WIDTHS[0]);
  if (first === originalUrl) return '';
  return [
    ...IMAGE_VARIANT_WIDTHS.map(w => `${imageVariantUrl(originalUrl, w)} ${w}w`),
    `${originalUrl} ${IMAGE_ORIGINAL_SRCSET_WIDTH}w`,
  ].join(', ');
}

/**
 * Undo a variant URL (used by the client-side 404 safety net): returns the
 * original URL, or null when `url` is not a variant URL.
 */
export function originalUrlOfVariant(url: string): string | null {
  try {
    const u = new URL(url);
    const base = baseKeyOfVariant(u.pathname);
    if (!base) return null;
    u.pathname = base;
    return u.toString();
  } catch {
    return null;
  }
}
