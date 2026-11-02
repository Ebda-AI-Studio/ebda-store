/** Deterministic post-processing: raw model reply -> staged, scored, sanitised items. Pure. */
import { normalizeArabicSearch } from '../search/arabic-normalize';
import { parseEgpPrice } from './price';
import { redactPersonalData } from './pii';
import { injectionMarkers, sanitizeCatalogueText } from './sanitize';
import { CATALOGUE_LIMITS, type CatalogueRawItem, type CatalogueRawPage } from './schema';

export const CATALOGUE_FLAGS = [
  'price_unclear',
  'price_range',
  'price_from',
  'price_per_unit',
  'currency_mismatch',
  'no_price',
  'phone_removed',
  'injection_suspected',
  'variants_truncated',
  'duplicate_sku',
  'duplicate_exact',
] as const;
export type CatalogueFlag = (typeof CATALOGUE_FLAGS)[number];

/** A merchant must tick "I checked this" before such an item can be accepted. */
export const BLOCKING_FLAGS: readonly CatalogueFlag[] = [
  'price_from',
  'price_per_unit',
  'injection_suspected',
  'duplicate_exact',
];

export const CATALOGUE_CONFIDENCE_BANDS = { high: 0.85, medium: 0.6 } as const;
export function confidenceBand(c: number): 'high' | 'medium' | 'low' {
  return c >= CATALOGUE_CONFIDENCE_BANDS.high
    ? 'high'
    : c >= CATALOGUE_CONFIDENCE_BANDS.medium
      ? 'medium'
      : 'low';
}

export interface StagedVariant {
  options: Record<string, string>;
  priceMinor: number | null;
  sku: string | null;
}

export interface StagedItem {
  name: string | null;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  priceMinor: number | null;
  compareAtMinor: number | null;
  priceRaw: string | null;
  sku: string | null;
  categoryName: string | null;
  categoryId: string | null;
  tags: string[];
  variants: StagedVariant[];
  confidence: number;
  flags: CatalogueFlag[];
  sourceText: string | null;
}

const FLAG_FACTOR: Partial<Record<CatalogueFlag, number>> = {
  price_unclear: 0.6,
  price_range: 0.6,
  price_from: 0.8,
  price_per_unit: 0.8,
  currency_mismatch: 0.5,
  no_price: 0.6,
  phone_removed: 0.95,
  variants_truncated: 0.8,
};
const INJECTION_CAP = 0.4;
const MAX_VARIANTS = 30;
const MAX_TAGS = 5;
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

export interface StageContext {
  storeCategories: Array<{ id: string; name: string; nameAr: string | null }>;
}

export function stageCatalogueItems(page: CatalogueRawPage, ctx: StageContext): StagedItem[] {
  const out: StagedItem[] = [];
  for (const raw of page.items) {
    const item = stageOne(raw, ctx);
    if (item) out.push(item);
  }
  return out;
}

function stageOne(raw: CatalogueRawItem, ctx: StageContext): StagedItem | null {
  const flags = new Set<CatalogueFlag>();
  let injection = false;
  const clean = (v: string | null, max: number): string | null => {
    if (!v) return null;
    const r = redactPersonalData(sanitizeCatalogueText(v, max));
    if (r.removed.length) flags.add('phone_removed');
    if (injectionMarkers(r.text).length) injection = true;
    return r.text || null;
  };

  let name = clean(raw.name, CATALOGUE_LIMITS.name);
  let nameAr = clean(raw.nameAr, CATALOGUE_LIMITS.name);
  // A name the model put in the wrong field follows its script.
  if (name && ARABIC.test(name) && !LATIN.test(name) && !nameAr) [name, nameAr] = [null, name];
  else if (nameAr && !ARABIC.test(nameAr) && LATIN.test(nameAr) && !name)
    [name, nameAr] = [nameAr, null];
  if (!name && !nameAr) return null;

  const description = clean(raw.description, CATALOGUE_LIMITS.description);
  const descriptionAr = clean(raw.descriptionAr, CATALOGUE_LIMITS.description);
  const sourceText = clean(raw.sourceText, CATALOGUE_LIMITS.source);
  let sku = clean(raw.sku, CATALOGUE_LIMITS.sku);
  if (sku && /^\+?\d[\d\s\-]{8,}$/.test(sku)) sku = null; // phone-shaped SKU

  // Price: the deterministic parse is authoritative; the model's own reading is a cross-check.
  const parsed = parseEgpPrice(raw.priceRaw);
  let priceMinor: number | null = null;
  let compareAtMinor: number | null = null;
  switch (parsed.kind) {
    case 'none':
      flags.add('no_price');
      break;
    case 'range':
      flags.add('price_range');
      break;
    default: {
      if (parsed.currency === 'OTHER') {
        flags.add('currency_mismatch');
        break;
      }
      if (parsed.ambiguous || parsed.minor === null) {
        flags.add('price_unclear');
        break;
      }
      const modelMinor = raw.priceEgp === null ? null : Math.round(raw.priceEgp * 100);
      if (modelMinor !== null && Math.abs(modelMinor - parsed.minor) > 1) {
        flags.add('price_unclear');
        break;
      }
      priceMinor = parsed.minor;
      compareAtMinor = parsed.compareAtMinor;
      if (parsed.kind === 'from') flags.add('price_from');
      if (parsed.kind === 'per_unit') flags.add('price_per_unit');
    }
  }
  if (compareAtMinor === null && raw.compareAtRaw) {
    const c = parseEgpPrice(raw.compareAtRaw);
    if (c.currency !== 'OTHER' && c.minor !== null && priceMinor !== null && c.minor > priceMinor)
      compareAtMinor = c.minor;
  }

  // Variants (max 30, price parsed deterministically; a variant with no price stays null and blocks publish).
  let variants: StagedVariant[] = raw.variants.map(v => {
    const p = parseEgpPrice(v.priceRaw);
    return {
      options: v.options,
      priceMinor: p.currency === 'OTHER' || p.kind === 'range' ? null : p.minor,
      sku: clean(v.sku, CATALOGUE_LIMITS.sku),
    };
  });
  if (variants.length > MAX_VARIANTS) {
    variants = variants.slice(0, MAX_VARIANTS);
    flags.add('variants_truncated');
  }
  if (priceMinor === null && variants.length) {
    const prices = variants.map(v => v.priceMinor).filter((n): n is number => n !== null);
    if (prices.length) {
      priceMinor = Math.min(...prices);
      flags.delete('no_price');
      flags.delete('price_range');
    }
  }

  // Tags: short printed labels only, no personal data, deduplicated on the fold.
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of raw.tags) {
    const c = clean(t, CATALOGUE_LIMITS.tag);
    const key = c ? normalizeArabicSearch(c) : '';
    if (!c || seen.has(key) || c.split(/\s+/).length > 4) continue;
    seen.add(key);
    tags.push(c);
    if (tags.length === MAX_TAGS) break;
  }

  // Category: fold-match an existing one; never create here.
  const categoryName = clean(raw.categoryName, CATALOGUE_LIMITS.category);
  let categoryId: string | null = null;
  if (categoryName) {
    const f = normalizeArabicSearch(categoryName);
    categoryId =
      ctx.storeCategories.find(
        c =>
          normalizeArabicSearch(c.name) === f || (c.nameAr && normalizeArabicSearch(c.nameAr) === f)
      )?.id ?? null;
  }

  if (injection) flags.add('injection_suspected');
  let confidence = raw.confidence;
  for (const f of flags) confidence *= FLAG_FACTOR[f] ?? 1;
  if (injection) confidence = Math.min(confidence, INJECTION_CAP);

  return {
    name,
    nameAr,
    description,
    descriptionAr,
    priceMinor,
    compareAtMinor,
    priceRaw: raw.priceRaw,
    sku,
    categoryName,
    categoryId,
    tags,
    variants,
    confidence: Math.round(confidence * 1000) / 1000,
    flags: [...flags],
    sourceText,
  };
}
