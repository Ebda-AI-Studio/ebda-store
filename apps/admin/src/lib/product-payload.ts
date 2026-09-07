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
  };
}
