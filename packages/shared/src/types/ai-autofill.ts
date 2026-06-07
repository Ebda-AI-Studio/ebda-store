/** Ownership of an AI-writable product field. Absent key = empty (unknown). */
export type FieldSource = 'ai' | 'human';

/** Map of field name → current owner. Stored in Product.aiFieldSources. */
export type AiFieldSources = Record<string, FieldSource>;

/**
 * Single source of truth for which Product fields the AI autofill engine
 * manages, and which other field(s) each one derives from. Both the
 * provenance-stamping diff (product.service) and the fill core
 * (ai-autofill.service) read this list so they can never disagree.
 *
 * BIDIRECTIONAL by design (Arabic-first market): the en/ar pairs list each
 * other as a source, so the engine fills whichever side is empty from the
 * side that's filled — write the Arabic and English auto-fills, write the
 * English and Arabic auto-fills. The fill core only translates when exactly
 * one side of a pair has content (smart-skip), so the mutual sourcing never
 * loops. SEO/meta fields list BOTH languages as sources so editing either the
 * Arabic or the English refreshes the AI-owned meta.
 *
 * AEO fields are intentionally excluded from v1.
 */
export const AI_AUTOFILL_FIELDS = [
  // en/ar content pairs — each fills from the other when empty
  { field: 'name', sources: ['nameAr'] },
  { field: 'nameAr', sources: ['name'] },
  { field: 'description', sources: ['descriptionAr'] },
  { field: 'descriptionAr', sources: ['description'] },
  // SEO/meta — derive from product content in EITHER language
  { field: 'metaTitle', sources: ['name', 'nameAr'] },
  { field: 'metaTitleAr', sources: ['nameAr', 'name'] },
  { field: 'metaDescription', sources: ['name', 'description', 'nameAr', 'descriptionAr'] },
  { field: 'metaDescriptionAr', sources: ['nameAr', 'descriptionAr', 'name', 'description'] },
] as const;

export type AiAutofillField = (typeof AI_AUTOFILL_FIELDS)[number]['field'];

/** All field names the engine manages. */
export const AI_AUTOFILL_FIELD_NAMES: string[] = AI_AUTOFILL_FIELDS.map(f => f.field);

/**
 * Given the current provenance map and the set of fields that just changed
 * on a product, return the AI-writable fields that should be (re)generated:
 *   - field is NOT human-owned (human always wins), AND
 *   - field is empty (no provenance entry → never generated) OR one of its
 *     declared sources appears in changedFields.
 *
 * The "empty fills regardless of changedFields" arm is essential: on product
 * CREATE the caller passes `changedFields: []`, and every empty field must
 * still fill. On UPDATE, an empty field fills (gap) and an `ai`-owned field
 * only refreshes when its source actually changed; `human` fields never move.
 */
export function fieldsNeedingRefresh(sources: AiFieldSources, changedFields: string[]): string[] {
  const changed = new Set(changedFields);
  return AI_AUTOFILL_FIELDS.filter(({ field, sources: src }) => {
    if (sources[field] === 'human') return false;
    const isEmpty = sources[field] === undefined;
    const sourceChanged = src.some(s => changed.has(s));
    return isEmpty || sourceChanged;
  }).map(f => f.field);
}
