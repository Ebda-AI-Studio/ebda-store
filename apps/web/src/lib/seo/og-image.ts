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

/**
 * Resolve the best og:image URL for a store-level page.
 *
 * Priority order:
 * 1. `rawUrl` (store.ogImage or store.logo) — if it is an absolute https URL
 * 2. Fallback: the `/opengraph-image` route on `siteUrl`, which generates a
 *    branded 1200×630 card via `next/og` `ImageResponse`
 *
 * The fallback guarantees a non-blank social preview even for stores with no
 * logo uploaded. The generated card uses the store's brand color and name.
 *
 * @param rawUrl   - Store logo or OG image URL (may be undefined or non-https)
 * @param siteUrl  - Canonical store base URL (e.g. "https://wadyaljuz.com")
 * @param alt      - Alt text / store name for accessibility and screen readers
 */
export function resolveStoreOgImage(
  rawUrl: string | null | undefined,
  siteUrl: string,
  alt: string
): OgImageEntry {
  // Only accept absolute https URLs — relative paths and http URLs are rejected
  // because WhatsApp's scraper silently drops non-https og:image values.
  const url = rawUrl && rawUrl.startsWith('https://') ? rawUrl : `${siteUrl}/opengraph-image`;

  return { url, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, alt };
}
