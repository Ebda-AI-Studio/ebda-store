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
  // Every rule of the shared policy (the API enforces the same five), named in the shopper's language.
  const en = passwordUnmetSentence(formData.password, 'en');
  const ar = passwordUnmetSentence(formData.password, 'ar');
  if (en && ar) return t(en, ar);
  return null;
}
