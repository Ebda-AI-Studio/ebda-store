/**
 * Empty-text handling for admin form payloads.
 *
 * Every write endpoint follows Prisma's convention on a nullable column:
 *   - `null`      → clear the stored value
 *   - `undefined` → key omitted from the JSON body → leave the stored value
 *
 * An EDIT form that mapped an emptied input to `undefined` therefore made
 * clearing impossible: the PUT succeeded and `updatedAt` moved, but the old
 * text survived. That is exactly how a live merchant lost the ability to
 * remove a product description.
 *
 * A CREATE form has nothing to clear, so `undefined` stays correct there —
 * it lets the API/Prisma column default apply instead of writing an explicit
 * null.
 *
 * Pass the value ALREADY trimmed when the caller trims (this helper does not
 * trim, so it never changes what a non-empty field sends).
 */
export type TextFieldIntent = 'create' | 'update';

export function textFieldValue(
  raw: string | null | undefined,
  intent: 'create'
): string | undefined;
export function textFieldValue(raw: string | null | undefined, intent: 'update'): string | null;
/**
 * Overload for the shared create-or-edit forms, where the intent is only
 * known at runtime (`editingId ? 'update' : 'create'`).
 */
export function textFieldValue(
  raw: string | null | undefined,
  intent: TextFieldIntent
): string | null | undefined;
export function textFieldValue(
  raw: string | null | undefined,
  intent: TextFieldIntent
): string | null | undefined {
  if (raw) return raw;
  return intent === 'update' ? null : undefined;
}

/**
 * Same clear-on-empty convention as {@link textFieldValue}, for a numeric
 * input backed by a string form field (money in fils, integer counts).
 *
 * `parse` runs ONLY when the field is non-empty, so a field-specific
 * transform (e.g. dinar → fils `v => parseInt(v) * 1000`) never has to
 * reimplement the null/undefined ternary at the call site — a coupon's
 * `minOrderAmount` sending `undefined` on an emptied field made the merchant
 * unable to remove an already-set minimum, the numeric sibling of the text
 * field bug this module was written for.
 */
export function numericFieldValue(
  raw: string | null | undefined,
  intent: 'create',
  parse: (raw: string) => number
): number | undefined;
export function numericFieldValue(
  raw: string | null | undefined,
  intent: 'update',
  parse: (raw: string) => number
): number | null;
export function numericFieldValue(
  raw: string | null | undefined,
  intent: TextFieldIntent,
  parse: (raw: string) => number
): number | null | undefined;
export function numericFieldValue(
  raw: string | null | undefined,
  intent: TextFieldIntent,
  parse: (raw: string) => number
): number | null | undefined {
  if (raw) return parse(raw);
  return intent === 'update' ? null : undefined;
}

/**
 * Same clear-on-empty convention as {@link textFieldValue}, for a
 * datetime-local input: sends an ISO string on a value, `null` to clear on
 * update, `undefined` (omitted key) on create.
 */
export function dateFieldValue(
  raw: string | null | undefined,
  intent: 'create'
): string | undefined;
export function dateFieldValue(raw: string | null | undefined, intent: 'update'): string | null;
export function dateFieldValue(
  raw: string | null | undefined,
  intent: TextFieldIntent
): string | null | undefined;
export function dateFieldValue(
  raw: string | null | undefined,
  intent: TextFieldIntent
): string | null | undefined {
  if (raw) return new Date(raw).toISOString();
  return intent === 'update' ? null : undefined;
}
