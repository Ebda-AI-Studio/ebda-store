/**
 * Validation of credential field values against the catalog, shared by the admin form and the
 * API (the API is the authority; the admin runs the same check for instant feedback).
 */
import type { CredentialFieldDef, ProviderCatalogEntry } from './catalog';

/** What a masked secret looks like when the admin echoes it back: it means "keep the saved one". */
export const MASKED_SECRET_PATTERN = /^\*{4}/;

export function isMaskedSecret(value: unknown): boolean {
  return typeof value === 'string' && MASKED_SECRET_PATTERN.test(value);
}

/** null when valid, else a short English reason (the admin localises by field label). */
export function validateCredentialValue(field: CredentialFieldDef, raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return field.required ? 'required' : null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'contains control characters';
  if (field.maxLength !== undefined && value.length > field.maxLength) return 'too long';
  if (field.type === 'integer' && !/^[0-9]+$/.test(value)) return 'must be a whole number';
  if (field.pattern && !new RegExp(field.pattern).test(value)) return 'has the wrong format';
  return null;
}

/** Required fields of `entry` that `values` (the stored set for one mode) does not have. */
export function missingRequiredFields(
  entry: ProviderCatalogEntry,
  values: Record<string, string | undefined>
): string[] {
  return entry.fields
    .filter(f => f.required && !(values[f.key] && values[f.key]!.trim().length > 0))
    .map(f => f.key);
}
