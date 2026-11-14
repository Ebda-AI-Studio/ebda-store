/** Mirrors `FeedHealth` from apps/api/src/lib/catalogue-feed/service.ts (`GET /stores/:id/product-feeds/health`). */
export type FeedLang = 'ar' | 'en';
export type IssueCode =
  | 'no_image'
  | 'zero_price'
  | 'variant_inactive'
  | 'no_title'
  | 'bundle_not_sellable'
  | 'description_missing'
  | 'gtin_invalid'
  | 'brand_is_store_name'
  | 'google_category_missing'
  | 'apparel_missing_attrs'
  | 'variant_options_missing';

export interface FeedIssue {
  id: string;
  groupId?: string;
  title: string;
  kind: 'excluded' | 'warning';
  code: IssueCode;
}

export interface FeedHealth {
  lang: FeedLang;
  origin: string;
  items: number;
  products: number;
  parts: number;
  excluded: number;
  warnings: number;
  byCode: Record<string, number>;
  issues: FeedIssue[];
  issuesTruncated: boolean;
  notPublished: { draft: number; archived: number; wholesaleOnly: number };
  shippingFlat: boolean;
  scanTruncated: boolean;
  generatedAt: string;
}

export type PlatformKey = 'google' | 'meta' | 'tiktok';
export const PLATFORM_FILES: Record<PlatformKey, string> = {
  google: 'google.xml',
  meta: 'meta.xml',
  tiktok: 'tiktok.csv',
};

/** The public feed URL for one platform + language. The storefront origin comes from the API, never the admin's own host. */
export function feedUrl(origin: string, platform: PlatformKey, lang: FeedLang): string {
  return `${origin.replace(/\/$/, '')}/feeds/${PLATFORM_FILES[platform]}?lang=${lang}`;
}
