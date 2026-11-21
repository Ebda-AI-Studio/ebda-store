import { storefrontOrigin } from '@ebda/shared';

/**
 * The absolute storefront link of an account email (verify, reset, magic link): the STORE's own origin (custom domain or
 * `<slug>.ebda.app`, never the platform `WEB_URL`, which serves no store) + the language prefix of the language the email is
 * written in (`/en/auth/...`), so the link opens the page in the language of the mail. Ruling LOCALE-PATHS-4.
 *
 * The storefront serves `/ar|/en` for every store while `STOREFRONT_LOCALE_PATHS` is not `false` (cf-web-deploy default `true`;
 * `false` is its rollback). Mirror that rollback here: set the same variable on the API Worker and links drop the prefix.
 */
/** The store origin + language prefix, the base the email templates append `/auth/login`, `/products`, `/checkout` to. */
export function storefrontBase(
  store: { slug: string; domain?: string | null },
  lang: 'en' | 'ar',
  env: Record<string, string | undefined> = process.env
): string {
  return `${storefrontOrigin(store)}${env.STOREFRONT_LOCALE_PATHS !== 'false' ? `/${lang}` : ''}`;
}

export function storefrontAuthLink(
  store: { slug: string; domain?: string | null },
  lang: 'en' | 'ar',
  pathAndQuery: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (!pathAndQuery.startsWith('/') || pathAndQuery.startsWith('//'))
    throw new Error('storefrontAuthLink: path must be a single-slash storefront path');
  return `${storefrontBase(store, lang, env)}${pathAndQuery}`;
}
