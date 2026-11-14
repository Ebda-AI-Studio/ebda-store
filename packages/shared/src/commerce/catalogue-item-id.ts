/**
 * THE catalogue item id: the one identifier every advertising and chat surface uses for "this sellable thing".
 *
 * Contract (docs/plans/2026-11-14-catalogue-feeds.md, Ruling FEEDS-2):
 *   - a simple product (no variants)       -> its product id
 *   - one variant of a variant product      -> the VARIANT id
 *   - a purchasable bundle                  -> the bundle id
 *   - the group of a variant product        -> the PRODUCT id (`item_group_id`, Meta/TikTok `product_group`)
 * Ids are database uuids: stable for the life of the row, never derived from a slug, a title or a position, so
 * renaming or reordering never orphans a catalogue item or breaks dynamic retargeting.
 *
 * Every consumer imports THIS function: the Google/Meta/TikTok feeds, the storefront pixel events (Meta Pixel,
 * TikTok Pixel, gtag `item_id`), the server-side CAPI Purchase event, and Ebda Chat's store bridge (`retailerId`).
 * A dynamic ad only matches when the feed `id` and the pixel `content_ids` are byte-identical.
 */
export interface CatalogueItemRef {
  productId: string;
  /** The variant, when the thing is one variant of a variant product. */
  variantId?: string | null;
}

/** The id of one sellable item (see the contract above). */
export function catalogueItemId(ref: CatalogueItemRef): string {
  return ref.variantId ? ref.variantId : ref.productId;
}

/** `item_group_id` / `product_group` id of a variant product's items. */
export function catalogueGroupId(productId: string): string {
  return productId;
}

/** A purchasable bundle's catalogue id. Bundles are a separate table; uuids never collide with product ids. */
export function catalogueBundleId(bundleId: string): string {
  return bundleId;
}
