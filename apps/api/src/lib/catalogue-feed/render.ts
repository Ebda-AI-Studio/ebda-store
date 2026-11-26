import { minorToDecimalString } from '@ebda/shared';
import type { FeedItem, FeedLang } from './build';

/**
 * Renderers. Google, Meta and TikTok take the same product facts in three wire shapes:
 *   google -> RSS 2.0 + g: namespace (Google Merchant Center spec)
 *   meta   -> the same RSS 2.0 + g: XML (Meta's catalog feed docs: "RSS XML ... g: prefix is supported"), with Meta's two
 *             availability words ("in stock" / "out of stock")
 *   tiktok -> CSV with TikTok's own column names (sku_id) and its availability words
 * Sources are cited in docs/plans/2026-11-14-catalogue-feeds.md.
 */
export type FeedPlatform = 'google' | 'meta' | 'tiktok';

// XML 1.0 forbids most control characters and lone surrogates; a stray one (copy-pasted from Word) makes the whole file unparseable.
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(XML_ILLEGAL, '')
    .replace(LONE_SURROGATE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const money = (minor: number, currency: string) =>
  `${minorToDecimalString(minor, currency)} ${currency}`;

const AVAILABILITY: Record<FeedPlatform, Record<FeedItem['availability'], string>> = {
  google: { in_stock: 'in_stock', out_of_stock: 'out_of_stock', backorder: 'backorder' },
  // Meta documents only `in stock` / `out of stock`; a backorder line is buyable now, so it stays `in stock` (Ruling FEEDS-5).
  meta: { in_stock: 'in stock', out_of_stock: 'out of stock', backorder: 'in stock' },
  tiktok: { in_stock: 'in stock', out_of_stock: 'out of stock', backorder: 'available for order' },
};

export function itemXml(it: FeedItem, platform: 'google' | 'meta'): string {
  const t = (tag: string, v: string | number | undefined) =>
    v === undefined || v === '' ? '' : `<g:${tag}>${xmlEscape(String(v))}</g:${tag}>`;
  const parts = [
    t('id', it.id),
    t('title', it.title),
    t('description', it.description),
    t('link', it.link),
    t('image_link', it.imageLink),
    ...it.additionalImageLinks.map(u => t('additional_image_link', u)),
    t('availability', AVAILABILITY[platform][it.availability]),
    t('price', money(it.priceMinor, it.currency)),
    it.salePriceMinor != null ? t('sale_price', money(it.salePriceMinor, it.currency)) : '',
    t('sale_price_effective_date', it.salePriceEffectiveDate),
    t('brand', it.brand),
    t('gtin', it.gtin),
    t('mpn', it.mpn),
    it.gtin || it.mpn ? '' : t('identifier_exists', 'no'),
    t('condition', it.condition),
    t('item_group_id', it.groupId),
    it.googleCategory ? t('google_product_category', it.googleCategory.id) : '',
    t('product_type', it.productType),
    t('color', it.color),
    t('size', it.size),
    t('material', it.material),
    t('gender', it.gender),
    t('age_group', it.ageGroup),
    it.weightGrams ? t('shipping_weight', `${it.weightGrams} g`) : '',
    it.shippingMinor != null
      ? `<g:shipping>${t('country', 'EG')}${t('price', money(it.shippingMinor, it.currency))}</g:shipping>`
      : '',
    // Meta keeps bundles distinguishable in its own tooling; Google ignores unknown custom labels
    it.isBundle ? t('custom_label_0', 'bundle') : '',
  ];
  return `<item>${parts.join('')}</item>`;
}

interface XmlHeader {
  storeName: string;
  origin: string;
  lang: FeedLang;
}
export function xmlHead(h: XmlHeader): string {
  const desc = h.lang === 'ar' ? `منتجات ${h.storeName}` : `${h.storeName} products`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>' +
    `<title>${xmlEscape(h.storeName)}</title><link>${xmlEscape(h.origin)}</link><description>${xmlEscape(desc)}</description>`
  );
}
export const XML_TAIL = '</channel></rss>';

// ---- TikTok CSV -----------------------------------------------------------------------------------------------------

const TIKTOK_COLUMNS = [
  'sku_id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'item_group_id',
  'google_product_category',
  'gtin',
  'mpn',
  'sale_price',
  'color',
  'size',
  'material',
  'gender',
  'age_group',
] as const;

/** RFC 4180 field, always quoted. A leading = + - @ is neutralised (spreadsheet formula injection from a merchant-typed title). */
export function csvField(v: string | number | undefined): string {
  let s = v === undefined ? '' : String(v);
  s = s.replace(XML_ILLEGAL, '').replace(LONE_SURROGATE, '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?( [A-Z]{3})?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const tiktokHeaderRow = (): string => TIKTOK_COLUMNS.join(',') + '\r\n';

/** TikTok accepts three category levels at most. */
const threeLevels = (path: string) => path.split(' > ').slice(0, 3).join(' > ');

export function itemCsvRow(it: FeedItem): string {
  const cat = it.googleCategory
    ? it.googleCategory.path
      ? threeLevels(it.googleCategory.path)
      : String(it.googleCategory.id)
    : '';
  const row: Record<(typeof TIKTOK_COLUMNS)[number], string | number | undefined> = {
    sku_id: it.id,
    title: it.title,
    description: it.description,
    availability: AVAILABILITY.tiktok[it.availability],
    condition: it.condition,
    price: money(it.priceMinor, it.currency),
    link: it.link,
    image_link: it.imageLink,
    additional_image_link: it.additionalImageLinks.join(','),
    brand: it.brand,
    item_group_id: it.groupId,
    google_product_category: cat,
    gtin: it.gtin,
    mpn: it.mpn,
    sale_price: it.salePriceMinor != null ? money(it.salePriceMinor, it.currency) : undefined,
    color: it.color,
    size: it.size,
    material: it.material,
    gender: it.gender,
    age_group: it.ageGroup,
  };
  return TIKTOK_COLUMNS.map(c => csvField(row[c])).join(',') + '\r\n';
}
