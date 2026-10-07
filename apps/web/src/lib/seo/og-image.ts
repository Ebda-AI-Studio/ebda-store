/**
 * Open Graph image utilities for per-store social previews.
 *
 * WhatsApp (and other OG scrapers: iMessage, Telegram, Slack, Twitter/X,
 * Facebook) require:
 *   - og:image = ABSOLUTE https URL (relative paths silently dropped)
 *   - og:image:width + og:image:height (WhatsApp shows a blank card without them)
 *   - Non-transparent, non-tiny image (≥200×200, ideally 1200×630)
 *
 * This module centralises the "which URL to use for og:image?" decision so
 * layout.tsx, product pages, and blog pages all share one path.
 */

/** Standard OG image dimensions used across all storefront pages. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** The output shape expected by Next.js Metadata `openGraph.images`. */
export interface OgImageEntry {
  url: string;
  width: number;
  height: number;
  alt: string;
}

/** Raster image extensions WhatsApp/social scrapers can render directly. */
const RASTER_EXT = /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i;

/**
 * Resolve the best og:image URL for a store-level page.
 *
 * Priority order:
 * 1. `ogImage` — the merchant's EXPLICITLY-uploaded social card, but only when
 *    it is an absolute https RASTER (png/jpg/webp/gif/avif). A designed 1200×630
 *    card should be used verbatim. (SVG / non-https values are ignored here —
 *    Satori can't <img> an SVG, and the generated card rasterizes it instead.)
 * 2. Fallback: the store-aware `/og?slug=<slug>` card route, which renders the
 *    store's logo (raster or SVG-rasterized) or name on the brand color.
 *
 * Passing the slug is what fixes path-based storefronts: the old fixed
 * `/opengraph-image` URL carried no store identity, so WhatsApp's fetch resolved
 * to the platform-default "Force" card. `/og?slug=<slug>` always renders the
 * right store. When `slug` is absent the card route falls back to the
 * host-resolved store (custom domains).
 *
 * @param ogImage  - Merchant's explicit og image URL (store.ogImage)
 * @param siteUrl  - Canonical store base URL (e.g. "https://demo-shop.example")
 * @param alt      - Alt text / store name for accessibility and screen readers
 * @param slug     - Store slug, threaded into the generated-card fallback URL
 */
export function resolveStoreOgImage(
  ogImage: string | null | undefined,
  siteUrl: string,
  alt: string,
  slug?: string | null
): OgImageEntry {
  const useExplicit = !!ogImage && ogImage.startsWith('https://') && RASTER_EXT.test(ogImage);
  const url = useExplicit
    ? (ogImage as string)
    : `${siteUrl}/og${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`;

  return { url, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, alt };
}
