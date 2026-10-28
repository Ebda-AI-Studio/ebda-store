import { validateStoreSlug } from '@ebda/shared';

/** A store name carried from a store host's 404 ("Start your store as <slug>") through signup to the store step. */
export const SIGNUP_SLUG_KEY = 'ebda.signup.slug';

/** Keep `raw` for the store step when it is a slug signup would accept; anything else is ignored. */
export function storeSignupSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const valid = validateStoreSlug(raw);
  if (!valid.ok) return null;
  try {
    window.localStorage.setItem(SIGNUP_SLUG_KEY, valid.slug);
  } catch {
    // Storage blocked (private window): the merchant types the name again.
  }
  return valid.slug;
}

export function readStoredSignupSlug(): string | null {
  try {
    const raw = window.localStorage.getItem(SIGNUP_SLUG_KEY);
    const valid = raw ? validateStoreSlug(raw) : null;
    return valid?.ok ? valid.slug : null;
  } catch {
    return null;
  }
}

export function clearStoredSignupSlug(): void {
  try {
    window.localStorage.removeItem(SIGNUP_SLUG_KEY);
  } catch {
    // nothing to clear
  }
}
