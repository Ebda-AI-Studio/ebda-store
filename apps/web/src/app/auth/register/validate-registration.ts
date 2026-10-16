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
    return t('Passwords do not match', 'كلمتين المرور مش زي بعض');
  }
  if (formData.password.length < 8) {
    return t('Password must be at least 8 characters', 'كلمة المرور لازم تكون 8 حروف على الأقل');
  }
  return null;
}
