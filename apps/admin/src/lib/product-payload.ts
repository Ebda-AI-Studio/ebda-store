import { textFieldValue, type TextFieldIntent } from './form-text';

/**
 * The product form fields that map to a NULLABLE free-text column and that a
 * merchant can legitimately empty. `name` is deliberately absent — it is
 * required and has no null form.
 */
export interface ProductTextFieldsForm {
  nameAr: string;
  description: string;
  descriptionAr: string;
  sku: string;
  /**
   * Merchant-authored product card badge, bilingual. Same clearable contract
   * as its siblings — emptying it on the edit form must send `null` or the
   * merchant can never remove a badge they no longer want, which is the
   * original clear-on-empty defect with a new field name.
   */
  badgeLabel: string;
  badgeLabelAr: string;
  /** Extra shopper words; emptied on edit must send null (clear). Server cleans + caps at 500. */
  searchTerms: string;
}

export type ProductTextFieldsPayload = Record<
  keyof ProductTextFieldsForm,
  string | null | undefined
>;

/**
 * Build the clearable free-text slice of the product create/update payload.
 *
 * Extracted from the two product pages so the empty-field contract is
 * testable: on the EDIT path an emptied input must send `null` (the API
 * clears the column), on the CREATE path it must send `undefined` (the key is
 * omitted — there is nothing to clear).
 *
 * The edit page previously sent `undefined` for all four, so the PUT
 * succeeded, `updatedAt` moved, and the old text survived: a merchant could
 * never remove a product description.
 */
export function productTextFields(
  form: ProductTextFieldsForm,
  intent: TextFieldIntent
): ProductTextFieldsPayload {
  return {
    nameAr: textFieldValue(form.nameAr, intent),
    description: textFieldValue(form.description, intent),
    descriptionAr: textFieldValue(form.descriptionAr, intent),
    sku: textFieldValue(form.sku, intent),
    // Trimmed at the call site — `textFieldValue` deliberately does not trim
    // (its doc: "pass the value ALREADY trimmed when the caller trims"), and
    // the pre-existing four fields are left byte-for-byte as they were. A
    // badge is a chip, so `"  "` typed into it is a clear, not a two-space
    // label: trimming here makes it send null instead of a whitespace string
    // that would render an empty coloured pill on every card.
    badgeLabel: textFieldValue(form.badgeLabel.trim(), intent),
    badgeLabelAr: textFieldValue(form.badgeLabelAr.trim(), intent),
    searchTerms: textFieldValue(form.searchTerms.trim(), intent),
  };
}

/**
 * The barcode slice of a product or variant payload (BARCODE-1). Not part of `productTextFields` on purpose:
 * omitted must mean "leave alone", because the API auto-generates a barcode and a form loaded before that
 * would otherwise clear it on save.
 *   create: typed -> sent, empty -> omitted (the API generates one when `inventory.barcode` is on).
 *   update: unchanged -> omitted, emptied -> null (clears), changed -> the new text (the API validates + checks uniqueness).
 */
export function barcodeField(
  typed: string,
  loaded: string | null | undefined,
  intent: 'create' | 'update'
): { barcode?: string | null } {
  const value = typed.trim();
  if (intent === 'create') return value ? { barcode: value } : {};
  if (value === (loaded ?? '')) return {};
  return { barcode: value || null };
}
