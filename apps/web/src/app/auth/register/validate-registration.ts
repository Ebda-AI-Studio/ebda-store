import { passwordUnmetSentence } from '@ebda/shared';

/**
 * Client-side registration validation.
 *
 * Returns the message to show, or null when the form is acceptable. Returning a
 * message instead of setting state is what makes the rules testable — they were
 * previously inlined in the submit handler behind two early returns that each
 * had to remember to clear `isLoading`, which is exactly the kind of bookkeeping
 * that rots.
 *
 * This is a UX guard, not a security boundary: the API re-validates. It exists so
 * a shopper is told immediately rather than after a round-trip.
 */
export function validateRegistration(
  formData: { password: string; confirmPassword: string },
  t: (en: string, ar: string) => string
): string | null {
  if (formData.password !== formData.confirmPassword) {
    return t('Passwords do not match', 'كلمة المرور وتأكيدها مش زي بعض');
  }
  return passwordPolicyError(formData.password, t);
}

/**
 * Every rule of the shared password policy (the API enforces the same five), named in the shopper's language, checked
 * before the request. The register and reset pages use this one function, so the form and the server cannot drift.
 */
export function passwordPolicyError(
  password: string,
  t: (en: string, ar: string) => string
): string | null {
  const en = passwordUnmetSentence(password, 'en');
  const ar = passwordUnmetSentence(password, 'ar');
  if (en && ar) return t(en, ar);
  return null;
}

/** The register API's 400 shown in the shopper's language (the server message is English and generic). */
export function registrationRefusalText(
  error: { code?: unknown } | null | undefined,
  t: (en: string, ar: string) => string
): string | null {
  if (error?.code !== 'VALIDATION_ERROR') return null;
  return t(
    'Please check what you entered: a valid email, and a password of at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol.',
    'راجع البيانات اللي كتبتها: الإيميل لازم يكون صحيح، وكلمة المرور 8 حروف على الأقل وفيها حرف إنجليزي كبير وحرف صغير ورقم ورمز.'
  );
}
