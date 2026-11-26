import { catalogueGroupId, catalogueItemId } from '@ebda/shared';
import { validGtin } from './gtin';
import { googleCategoryFor, isApparel, type GoogleCategory } from './taxonomy';

/**
 * Pure builder: store rows -> neutral catalogue items + the products/variants that are NOT advertisable and why.
 * No I/O, no clock, no platform wording - the renderers (render.ts) turn items into Google/Meta XML and TikTok CSV.
 * Spec sources: docs/plans/2026-11-14-catalogue-feeds.md.
 */
export type FeedLang = 'ar' | 'en';

export interface FeedStoreInfo {
  name: string;
  nameAr?: string | null;
  currency: string;
  /** Storefront origin, never request-derived (feed poisoning, P1-2). */
  origin: string;
  /** One flat delivery fee when EVERY active shipping rate is the same; null = varies or none. */
  flatShippingMinor?: number | null;
}

interface FeedVariantRow {
  id: string;
  title: string;
  titleAr?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
  inventory: number;
  allowBackorder?: boolean | null;
  isActive: boolean;
  weight?: number | null;
  imageUrl?: string | null;
  /** ProductOptionValue ids chosen by this variant. */
  optionValueIds: string[];
}

export interface FeedProductRow {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  description?: string | null;
  descriptionAr?: string | null;
  excerpt?: string | null;
  excerptAr?: string | null;
  price: number;
  compareAtPrice?: number | null;
  sku?: string | null;
  barcode?: string | null;
  inventory: number;
  trackInventory?: boolean | null;
  allowBackorder?: boolean | null;
  weight?: number | null;
  facts?: unknown;
  images: Array<{ url: string; position: number }>;
  categories: Array<{
    category: {
      name: string;
      nameAr?: string | null;
      slug: string;
      parentId?: string | null;
      id?: string;
    };
  }>;
  options: Array<{
    name: string;
    nameAr?: string | null;
    values: Array<{ id: string; value: string; valueAr?: string | null }>;
  }>;
  variants: FeedVariantRow[];
}

export interface FeedBundleRow {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  image?: string | null;
  price: number;
  componentSum: number;
  description?: string;
  descriptionAr?: string;
  startsAt?: Date | string | null;
  expiresAt?: Date | string | null;
}

export type Availability = 'in_stock' | 'out_of_stock' | 'backorder';

export interface FeedItem {
  /** The ONE catalogue item id (catalogueItemId). */
  id: string;
  groupId?: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: string[];
  availability: Availability;
  /** Regular price in minor units; `salePriceMinor` is what the shopper pays when set. */
  priceMinor: number;
  salePriceMinor?: number;
  salePriceEffectiveDate?: string;
  currency: string;
  brand: string;
  gtin?: string;
  mpn?: string;
  identifierExists: boolean;
  condition: 'new';
  googleCategory?: GoogleCategory;
  productType?: string;
  color?: string;
  size?: string;
  material?: string;
  gender?: 'male' | 'female' | 'unisex';
  ageGroup?: 'newborn' | 'infant' | 'toddler' | 'kids' | 'adult';
  weightGrams?: number;
  shippingMinor?: number;
  isBundle?: boolean;
}

type ExcludeReason =
  | 'no_image'
  | 'zero_price'
  | 'variant_inactive'
  | 'no_title'
  | 'bundle_not_sellable';

export type Warning =
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
  code: ExcludeReason | Warning;
}

export interface BuildContext {
  store: FeedStoreInfo;
  lang: FeedLang;
  backorderOn: boolean;
  /** category id -> row, for the breadcrumb (`productType`). */
  categoryById: Map<string, { name: string; nameAr?: string | null; parentId?: string | null }>;
}

const TITLE_MAX = 150;
const DESC_MAX = 5000;
const BRAND_MAX = 70;
const MAX_ADDITIONAL_IMAGES = 10;

const cut = (s: string, n: number): string => {
  const a = Array.from(s);
  return a.length <= n ? s : a.slice(0, n).join('').trimEnd();
};
/** Plain text: tags out, entities for the common three decoded, whitespace collapsed (feeds are plain text). */
const plainText = (s: string | null | undefined): string =>
  (s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
/** A title is plain text already: collapse whitespace, never strip `<...>` (an Arabic or English title may contain them). */
const oneLine = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const pick = (lang: FeedLang, en?: string | null, ar?: string | null): string =>
  (lang === 'ar' ? ar || en : en || ar) ?? '';
const isHttpUrl = (u: string | null | undefined): u is string =>
  !!u && /^https?:\/\/[^\s]+$/i.test(u);

interface Fact {
  key: string;
  keyAr: string;
  value: string;
  valueAr: string;
}
const factsOf = (raw: unknown): Fact[] =>
  Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>).map(f => ({
        key: String(f?.key ?? ''),
        keyAr: String(f?.keyAr ?? ''),
        value: String(f?.value ?? ''),
        valueAr: String(f?.valueAr ?? ''),
      }))
    : [];
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .trim();
const factValue = (facts: Fact[], names: string[], lang: FeedLang): string | undefined => {
  const f = facts.find(x => names.includes(norm(x.key)) || names.includes(norm(x.keyAr)));
  const v = f ? pick(lang, f.value, f.valueAr) : '';
  return v || undefined;
};

const OPTION_ATTR: Array<['size' | 'color' | 'material' | 'gender' | 'ageGroup', RegExp]> = [
  ['size', /size|مقاس|حجم|قياس/i],
  ['color', /colou?r|لون/i],
  ['material', /material|خامة|خامه|مادة|قماش/i],
  ['gender', /gender|الجنس|النوع/i],
  ['ageGroup', /age|العمر|الفئة/i],
];

const GENDER: Array<[RegExp, 'male' | 'female' | 'unisex']> = [
  [/unisex|للجنسين|للكل/i, 'unisex'],
  [/female|women|woman|ladies|girl|نسائي|حريمي|بناتي|انثى|أنثى|نساء/i, 'female'],
  [/male|men|man|boy|رجالي|ولادي|ذكر|رجال/i, 'male'],
];
const AGE: Array<[RegExp, NonNullable<FeedItem['ageGroup']>]> = [
  [/newborn|حديث الولادة/i, 'newborn'],
  [/infant|رضيع|رضع/i, 'infant'],
  [/toddler|طفل صغير/i, 'toddler'],
  [/kid|child|children|اطفال|أطفال|طفل/i, 'kids'],
  [/adult|بالغ|كبار/i, 'adult'],
];
const firstMatch = <T>(table: Array<[RegExp, T]>, v: string | undefined): T | undefined =>
  v ? table.find(([re]) => re.test(v))?.[1] : undefined;

function availabilityOf(
  stock: { inventory: number; trackInventory?: boolean | null },
  allowsBackorder: boolean,
  backorderOn: boolean
): Availability {
  if (stock.trackInventory === false) return 'in_stock';
  if (stock.inventory > 0) return 'in_stock';
  return backorderOn && allowsBackorder ? 'backorder' : 'out_of_stock';
}

/** Breadcrumb "Parent > Child" of the deepest-first category. Cycle-safe. */
function breadcrumb(
  catId: string | undefined,
  ctx: BuildContext,
  fallback: { name: string; nameAr?: string | null } | undefined
): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = catId;
  while (cur && !seen.has(cur) && parts.length < 5) {
    seen.add(cur);
    const c = ctx.categoryById.get(cur);
    if (!c) break;
    parts.unshift(pick(ctx.lang, c.name, c.nameAr));
    cur = c.parentId ?? undefined;
  }
  if (parts.length === 0 && fallback) parts.push(pick(ctx.lang, fallback.name, fallback.nameAr));
  return parts.length ? parts.join(' > ') : undefined;
}

export function buildProductItems(
  products: FeedProductRow[],
  ctx: BuildContext
): { items: FeedItem[]; issues: FeedIssue[] } {
  const items: FeedItem[] = [];
  const issues: FeedIssue[] = [];
  const { store, lang } = ctx;
  const storeName = pick(lang, store.name, store.nameAr);

  for (const p of products) {
    const facts = factsOf(p.facts);
    const baseTitle = cut(oneLine(pick(lang, p.name, p.nameAr)), TITLE_MAX);
    const link = `${store.origin}/products/${encodeURIComponent(p.slug)}`;
    const images = [...p.images]
      .filter(i => isHttpUrl(i.url))
      .sort((a, b) => a.position - b.position)
      .map(i => i.url);
    const rawDesc =
      plainText(pick(lang, p.description, p.descriptionAr)) ||
      plainText(pick(lang, p.excerpt, p.excerptAr));
    const brandFact = factValue(facts, ['brand', 'الماركة', 'ماركة', 'العلامة التجارية'], lang);
    const brand = cut(brandFact ?? storeName, BRAND_MAX);
    const cats = p.categories.map(c => c.category);
    // deepest category first: one that is nobody's parent among this product's categories, else the first
    const parentIds = new Set(cats.map(c => c.parentId).filter(Boolean) as string[]);
    const ordered = [...cats].sort(
      (a, b) => Number(parentIds.has(a.id ?? '')) - Number(parentIds.has(b.id ?? ''))
    );
    const pinned = Number(factValue(facts, ['google_product_category'], lang));
    const googleCategory: GoogleCategory | undefined =
      Number.isInteger(pinned) && pinned > 0
        ? { id: pinned, path: '' }
        : (ordered.map(c => googleCategoryFor(c.name, c.nameAr, c.slug)).find(Boolean) ??
          undefined);
    const productType = breadcrumb(ordered[0]?.id, ctx, ordered[0]);
    const gender = firstMatch(GENDER, factValue(facts, ['gender', 'الجنس', 'النوع'], lang));
    const ageGroup = firstMatch(
      AGE,
      factValue(facts, ['age group', 'age_group', 'الفئة العمرية'], lang)
    );
    const factMaterial = factValue(facts, ['material', 'الخامة', 'خامة'], lang);
    const mpnFact = factValue(facts, ['mpn'], lang);

    const emitIssue = (
      id: string,
      title: string,
      code: FeedIssue['code'],
      kind: FeedIssue['kind'],
      groupId?: string
    ) => issues.push({ id, groupId, title, kind, code });

    if (!baseTitle) {
      emitIssue(p.id, p.id, 'no_title', 'excluded');
      continue;
    }

    const variants = p.variants;
    const valueById = new Map<
      string,
      { optionName: string; optionNameAr?: string | null; value: string; valueAr?: string | null }
    >();
    for (const o of p.options)
      for (const v of o.values)
        valueById.set(v.id, {
          optionName: o.name,
          optionNameAr: o.nameAr,
          value: v.value,
          valueAr: v.valueAr,
        });

    const make = (
      ref: { variantId?: string | null },
      over: {
        title: string;
        priceMinor: number;
        compareAt?: number | null;
        stock: { inventory: number; trackInventory?: boolean | null };
        allowsBackorder: boolean;
        gtinRaw?: string | null;
        sku?: string | null;
        weightKg?: number | null;
        image?: string | null;
        variantRow?: FeedVariantRow;
      }
    ) => {
      const id = catalogueItemId({ productId: p.id, variantId: ref.variantId });
      const group = ref.variantId ? catalogueGroupId(p.id) : undefined;
      const img = over.image && isHttpUrl(over.image) ? over.image : images[0];
      if (over.priceMinor <= 0) {
        emitIssue(id, over.title, 'zero_price', 'excluded', group);
        return;
      }
      if (!img) {
        emitIssue(id, over.title, 'no_image', 'excluded', group);
        return;
      }
      const onSale = over.compareAt != null && over.compareAt > over.priceMinor;
      const gtin = validGtin(over.gtinRaw) ?? undefined;
      if (over.gtinRaw && !gtin) emitIssue(id, over.title, 'gtin_invalid', 'warning', group);
      const item: FeedItem = {
        id,
        ...(group ? { groupId: group } : {}),
        title: over.title,
        description: cut(rawDesc || over.title, DESC_MAX),
        link,
        imageLink: img,
        additionalImageLinks: [...(over.image && isHttpUrl(over.image) ? images : images.slice(1))]
          .filter(u => u !== img)
          .slice(0, MAX_ADDITIONAL_IMAGES),
        availability: availabilityOf(over.stock, over.allowsBackorder, ctx.backorderOn),
        priceMinor: onSale ? over.compareAt! : over.priceMinor,
        ...(onSale ? { salePriceMinor: over.priceMinor } : {}),
        currency: store.currency,
        brand,
        ...(gtin ? { gtin } : {}),
        ...(!gtin && mpnFact ? { mpn: cut(mpnFact, 70) } : {}),
        identifierExists: !!(gtin || mpnFact),
        condition: 'new',
        ...(googleCategory ? { googleCategory } : {}),
        ...(productType ? { productType } : {}),
        ...(factMaterial ? { material: cut(factMaterial, 200) } : {}),
        ...(gender ? { gender } : {}),
        ...(ageGroup ? { ageGroup } : {}),
        ...(over.weightKg && over.weightKg > 0
          ? { weightGrams: Math.round(over.weightKg * 1000) }
          : {}),
        ...(store.flatShippingMinor != null ? { shippingMinor: store.flatShippingMinor } : {}),
      };
      // variant attributes from the chosen option values
      if (over.variantRow) {
        for (const vid of over.variantRow.optionValueIds) {
          const ov = valueById.get(vid);
          if (!ov) continue;
          const attr = OPTION_ATTR.find(
            ([, re]) => re.test(ov.optionName) || re.test(ov.optionNameAr ?? '')
          )?.[0];
          const text = cut(oneLine(pick(lang, ov.value, ov.valueAr)), 100);
          if (!attr || !text) continue;
          if (attr === 'gender') item.gender ??= firstMatch(GENDER, text);
          else if (attr === 'ageGroup') item.ageGroup ??= firstMatch(AGE, text);
          else item[attr] = text;
        }
        if (over.variantRow.optionValueIds.length === 0)
          emitIssue(id, over.title, 'variant_options_missing', 'warning', group);
      }
      if (!rawDesc) emitIssue(id, over.title, 'description_missing', 'warning', group);
      if (!brandFact) emitIssue(id, over.title, 'brand_is_store_name', 'warning', group);
      if (!googleCategory) emitIssue(id, over.title, 'google_category_missing', 'warning', group);
      if (
        isApparel(googleCategory ?? null) &&
        !(item.color && item.size && item.gender && item.ageGroup)
      ) {
        emitIssue(id, over.title, 'apparel_missing_attrs', 'warning', group);
      }
      items.push(item);
    };

    if (variants.length === 0) {
      make(
        {},
        {
          title: baseTitle,
          priceMinor: p.price,
          compareAt: p.compareAtPrice,
          stock: p,
          allowsBackorder: p.allowBackorder === true,
          gtinRaw: p.barcode,
          sku: p.sku,
          weightKg: p.weight,
        }
      );
      continue;
    }
    for (const v of variants) {
      const vTitle = pick(lang, v.title, v.titleAr);
      const title = cut(oneLine(vTitle ? `${baseTitle} - ${vTitle}` : baseTitle), TITLE_MAX);
      if (!v.isActive) {
        emitIssue(
          catalogueItemId({ productId: p.id, variantId: v.id }),
          title,
          'variant_inactive',
          'excluded',
          p.id
        );
        continue;
      }
      make(
        { variantId: v.id },
        {
          title,
          priceMinor: v.price ?? p.price,
          // a variant product ignores the parent's compare-at, exactly like the storefront (getProductPricing)
          compareAt: v.compareAtPrice,
          stock: { inventory: v.inventory, trackInventory: p.trackInventory },
          allowsBackorder: v.allowBackorder === true || p.allowBackorder === true,
          gtinRaw: v.barcode,
          sku: v.sku,
          weightKg: v.weight ?? p.weight,
          image: v.imageUrl,
          variantRow: v,
        }
      );
    }
  }
  return { items, issues };
}

const isoMinute = (d: Date | string) => new Date(d).toISOString().slice(0, 16) + 'Z';

/** Purchasable-right-now bundles (the caller applies the sale window per request). */
export function buildBundleItems(bundles: FeedBundleRow[], ctx: BuildContext): FeedItem[] {
  const { store, lang } = ctx;
  const out: FeedItem[] = [];
  for (const b of bundles) {
    const title = cut(oneLine(pick(lang, b.name, b.nameAr)), TITLE_MAX);
    if (!title || !isHttpUrl(b.image) || b.price <= 0) continue;
    const onSale = b.componentSum > b.price;
    const desc = plainText(pick(lang, b.description, b.descriptionAr)) || title;
    out.push({
      id: b.id,
      title,
      description: cut(desc, DESC_MAX),
      link: `${store.origin}/bundles/${encodeURIComponent(b.slug)}`,
      imageLink: b.image,
      additionalImageLinks: [],
      availability: 'in_stock',
      priceMinor: onSale ? b.componentSum : b.price,
      ...(onSale ? { salePriceMinor: b.price } : {}),
      ...(onSale && b.startsAt && b.expiresAt
        ? { salePriceEffectiveDate: `${isoMinute(b.startsAt)}/${isoMinute(b.expiresAt)}` }
        : {}),
      currency: store.currency,
      brand: cut(pick(lang, store.name, store.nameAr), BRAND_MAX),
      identifierExists: false,
      condition: 'new',
      isBundle: true,
      ...(store.flatShippingMinor != null ? { shippingMinor: store.flatShippingMinor } : {}),
    });
  }
  return out;
}
