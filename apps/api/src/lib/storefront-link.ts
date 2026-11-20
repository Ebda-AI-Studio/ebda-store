import { storefrontOrigin } from '@ebda/shared';

/**
 * Every link a SHOPPER email carries points at the store's OWN storefront (verified custom domain, else `<slug>.ebda.app`),
 * in the shopper's language - never at WEB_URL / ADMIN_URL (store.ebda.app is the merchant admin app; a shopper token
 * opened there is rejected and the shopper lands on the wrong product). One helper so no email builds its own base.
 */
export interface StorefrontLinkStore {
  slug: string;
  domain?: string | null;
}

/** `https://<host>/<lang>` - the base for any storefront link in a shopper email. */
export function storefrontBase(store: StorefrontLinkStore, lang: 'en' | 'ar'): string {
  return `${storefrontOrigin(store)}/${lang}`;
}

/** A one-time-token page on the storefront (`verify-email`, `reset-password`). */
export function storefrontTokenLink(
  store: StorefrontLinkStore,
  lang: 'en' | 'ar',
  page: 'verify-email' | 'reset-password',
  token: string
): string {
  return `${storefrontBase(store, lang)}/auth/${page}?token=${encodeURIComponent(token)}`;
}
