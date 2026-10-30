/**
 * The reply contract for one catalogue file. EVERY field is optional or nullable and coerced, so a
 * partial or odd reply degrades the item, not the file; unknown keys are dropped (zod default).
 */
import { z } from 'zod/v3';
import { sanitizeCatalogueText } from './sanitize';

export const CATALOGUE_LIMITS = {
  name: 200,
  description: 1000,
  priceRaw: 60,
  sku: 60,
  category: 120,
  tag: 30,
  source: 160,
  itemsPerFile: 120,
  rawVariants: 200,
} as const;

const str = (max: number) =>
  z
    .unknown()
    .transform(v =>
      typeof v === 'string'
        ? sanitizeCatalogueText(v, max) || null
        : typeof v === 'number'
          ? String(v)
          : null
    );

const num01 = z.unknown().transform(v => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
});

const looseNumber = z.unknown().transform(v => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
});

const rawVariant = z.object({
  options: z.unknown().transform(v => {
    const out: Record<string, string> = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 3)) {
        const key = sanitizeCatalogueText(k, 30);
        const value =
          typeof val === 'string' || typeof val === 'number'
            ? sanitizeCatalogueText(String(val), 60)
            : '';
        if (key && value) out[key] = value;
      }
    }
    return out;
  }),
  priceRaw: str(CATALOGUE_LIMITS.priceRaw),
  sku: str(CATALOGUE_LIMITS.sku),
});

export const catalogueRawItemSchema = z.object({
  name: str(CATALOGUE_LIMITS.name),
  nameAr: str(CATALOGUE_LIMITS.name),
  description: str(CATALOGUE_LIMITS.description),
  descriptionAr: str(CATALOGUE_LIMITS.description),
  priceRaw: str(CATALOGUE_LIMITS.priceRaw),
  priceEgp: looseNumber,
  compareAtRaw: str(CATALOGUE_LIMITS.priceRaw),
  sku: str(CATALOGUE_LIMITS.sku),
  categoryName: str(CATALOGUE_LIMITS.category),
  tags: z.unknown().transform(v =>
    Array.isArray(v)
      ? v
          .filter((t): t is string => typeof t === 'string')
          .map(t => sanitizeCatalogueText(t, CATALOGUE_LIMITS.tag))
          .filter(Boolean)
          .slice(0, 20)
      : []
  ),
  variants: z.unknown().transform(v =>
    Array.isArray(v)
      ? v
          .slice(0, CATALOGUE_LIMITS.rawVariants)
          .map(x => rawVariant.safeParse(x))
          .filter(r => r.success)
          .map(r => (r as { success: true; data: z.infer<typeof rawVariant> }).data)
      : []
  ),
  sourceText: str(CATALOGUE_LIMITS.source),
  confidence: num01,
});
export type CatalogueRawItem = z.infer<typeof catalogueRawItemSchema>;

export const catalogueRawPageSchema = z.object({
  // A non-array `items` fails the whole file (a failure, not a crash). Bad single items are dropped.
  items: z.array(z.unknown()).transform(arr =>
    arr
      .slice(0, CATALOGUE_LIMITS.itemsPerFile)
      .map(x => catalogueRawItemSchema.safeParse(x))
      .filter(r => r.success)
      .map(r => (r as { success: true; data: CatalogueRawItem }).data)
  ),
  pageNote: str(200).optional(),
});
export type CatalogueRawPage = z.infer<typeof catalogueRawPageSchema>;

/**
 * The model's JSON response schema (Gemini structured output). Mirrors the raw item above; kept as
 * plain data so the API can pass it straight to `responseSchema`.
 */
export const CATALOGUE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', nullable: true },
          nameAr: { type: 'STRING', nullable: true },
          description: { type: 'STRING', nullable: true },
          descriptionAr: { type: 'STRING', nullable: true },
          priceRaw: { type: 'STRING', nullable: true },
          priceEgp: { type: 'NUMBER', nullable: true },
          compareAtRaw: { type: 'STRING', nullable: true },
          sku: { type: 'STRING', nullable: true },
          categoryName: { type: 'STRING', nullable: true },
          tags: { type: 'ARRAY', items: { type: 'STRING' } },
          variants: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                options: {
                  type: 'OBJECT',
                  properties: {
                    size: { type: 'STRING' },
                    color: { type: 'STRING' },
                    weight: { type: 'STRING' },
                  },
                },
                priceRaw: { type: 'STRING', nullable: true },
                sku: { type: 'STRING', nullable: true },
              },
            },
          },
          sourceText: { type: 'STRING', nullable: true },
          confidence: { type: 'NUMBER' },
        },
      },
    },
    pageNote: { type: 'STRING', nullable: true },
  },
  required: ['items'],
} as const;
