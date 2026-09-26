/**
 * og:image resolution shared by the product PDP and bundle detail metadata
 * builders (dream #1811 — the two builders had drifted into an identical
 * ~15-line ternary + array literal). The rule is the same for both: use the
 * item's own photo when it has one, else fall back to the store-aware OG
 * card (`/og?slug=`) so an imageless product/bundle still gets a branded
 * preview instead of a blank one.
 */
export interface OgImage {
  url: string;
  alt: string;
  width?: number;
  height?: number;
}

export function buildOgImages(
  itemImageUrl: string | null | undefined,
  storeSlug: string | null | undefined,
  storeName: string,
  itemAlt: string
): OgImage[] {
  if (itemImageUrl) return [{ url: itemImageUrl, alt: itemAlt }];
  if (!storeSlug) return [];
  return [
    {
      url: `/og?slug=${encodeURIComponent(storeSlug)}`,
      width: 1200,
      height: 630,
      alt: storeName,
    },
  ];
}
