// Client-side mirrors of the signup rules the API enforces
// (apps/api/src/services/merchant-signup.service.ts), so the form can answer
// instantly. The API stays the authority; these only avoid a round trip.
import { isValidEgyptianMobile, isValidEmail, slugify } from '@ebda/shared';

/** Same policy as the API: 8+ chars, upper, lower, digit, symbol. */
export function isStrongPassword(password: string): boolean {
  return (
    password.length >= 8 &&
    password.length <= 128 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

export interface SignupFields {
  name: string;
  email: string;
  phone: string;
  password: string;
}

export type SignupErrorKey =
  | 'nameRequired'
  | 'emailInvalid'
  | 'emailDisposable'
  | 'passwordWeak'
  | 'phoneRequired'
  | 'phoneInvalid';

export function validateSignup(
  f: SignupFields
): Partial<Record<keyof SignupFields, SignupErrorKey>> {
  const errors: Partial<Record<keyof SignupFields, SignupErrorKey>> = {};
  if (!f.name.trim()) errors.name = 'nameRequired';
  if (!isValidEmail(f.email.trim())) errors.email = 'emailInvalid';
  if (!isStrongPassword(f.password)) errors.password = 'passwordWeak';
  if (!f.phone.trim()) errors.phone = 'phoneRequired';
  else if (!isValidEgyptianMobile(f.phone)) errors.phone = 'phoneInvalid';
  return errors;
}

/** `250` / `250.5` / `٢٥٠` -> piastres, or null when not a positive amount. */
export function egpToPiastres(input: string): number | null {
  const ascii = input
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace('٫', '.')
    .replace(',', '.')
    .trim();
  if (!/^\d+(\.\d{1,2})?$/.test(ascii)) return null;
  const piastres = Math.round(parseFloat(ascii) * 100);
  return piastres > 0 ? piastres : null;
}

/** Suggest a latin store address from a store name; Arabic-only names yield ''. */
export function suggestSlug(name: string): string {
  return slugify(name, { ascii: true, max: 40 });
}
