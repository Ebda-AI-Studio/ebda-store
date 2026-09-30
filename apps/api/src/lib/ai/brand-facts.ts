import { z } from 'zod';

/**
 * Write-side schema for `Store.aboutJson` from the bulk-ai-brand-facts sweep
 * (#1892). The model's JSON used to be persisted verbatim behind only a
 * `typeof parsed === 'object'` check, so a nested value (`contactMethods:
 * [{ type, value }]`, an `address` object) reached the public Organization
 * JSON-LD as the string "[object Object]" on every page of the store.
 *
 * Only the six keys the prompt asks for survive, each in its expected shape;
 * an array keeps its string items and drops anything else. A key whose value
 * is unusable is dropped rather than failing the whole object.
 */
const text = z.string().trim().min(1).max(200);
const SHAPES = {
  location: text,
  region: text,
  currency: text,
  languages: z.array(z.unknown()),
  keyCategories: z.array(z.unknown()),
  contactMethods: z.array(z.unknown()),
} as const;

export type BrandFacts = Partial<{
  location: string;
  region: string;
  currency: string;
  languages: string[];
  keyCategories: string[];
  contactMethods: string[];
}>;

export function normalizeBrandFacts(parsed: unknown): BrandFacts | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(SHAPES)) {
    const result = schema.safeParse((parsed as Record<string, unknown>)[key]);
    if (!result.success) continue;
    if (Array.isArray(result.data)) {
      const items = result.data
        .filter((v): v is string => typeof v === 'string')
        .map(v => v.trim())
        .filter(v => v.length > 0 && v.length <= 200)
        .slice(0, 50);
      if (items.length > 0) out[key] = items;
    } else {
      out[key] = result.data;
    }
  }
  return Object.keys(out).length > 0 ? (out as BrandFacts) : null;
}
