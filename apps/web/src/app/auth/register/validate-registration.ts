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
 * The API's password policy (auth.routes registerSchema, reset-password's passwordSchema: 8-128 characters with an
 * uppercase letter, a lowercase letter, a number and a symbol), checked before the request. The form used to check the
 * length only, so a shopper typing "abcd1234" got the API's 400 "Invalid request data" in English (2026-11-18, live).
 */
export function passwordPolicyError(
  password: string,
  t: (en: string, ar: string) => string
): string | null {
  if (password.length < 8) {
    return t('Password must be at least 8 characters', 'كلمة المرور لازم تكون 8 حروف على الأقل');
  }
  if (
    password.length > 128 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    return t(
      'Use at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol (like ! or @).',
      'كلمة المرور لازم يكون فيها حرف إنجليزي كبير وحرف صغير ورقم ورمز زي ! أو @، و8 حروف على الأقل.'
    );
  }
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
