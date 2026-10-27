import {
  BRAND,
  BRAND_MARKETING_URL,
  BRAND_STORE_APP_URL,
  validateStoreSlug,
  whatsappUrl,
} from '@ebda/shared';
import type { ResolvedStore } from './store-resolver';
import { DEMO_HOSTS } from './demo-hosts';

/**
 * Routing + link decisions for the generic Ebda 404 shown on a host that is
 * not a live store (Ruling SUBDOMAIN-404-1).
 */

export type NotFoundKind = 'store' | 'unknown-host';

/**
 * Which 404 a request gets. Store context = the Host named a store AND that
 * store actually resolved (the sentinel `demo` chrome means it did not: an
 * unknown or inactive `<slug>.ebda.app`, an unenrolled custom domain, or the
 * bare platform host). A suspended store still resolves, so it never lands here.
 */
export function notFoundKind(
  storeDomain: string | null | undefined,
  store: Pick<ResolvedStore, 'id'>
): NotFoundKind {
  return !!storeDomain && store.id !== 'demo' ? 'store' : 'unknown-host';
}

export interface UnknownHostLinks {
  /** "Make your store on Ebda" target. */
  createStoreUrl: string;
  /** wa.me link, or null when the platform has no support WhatsApp number. */
  whatsappHref: string | null;
  /** Demo store link, or null unless the flag is on (the demo store is not live yet). */
  demoStoreHref: string | null;
}

/** `SHOW_DEMO_STORE_LINK` must be exactly `true`; anything else keeps the link off. */
export function unknownHostLinks(
  env: Record<string, string | undefined> = process.env
): UnknownHostLinks {
  const number = BRAND.contact.whatsapp?.replace(/\D/g, '') ?? '';
  return {
    createStoreUrl: BRAND_MARKETING_URL,
    whatsappHref: number ? whatsappUrl() : null,
    demoStoreHref:
      env.SHOW_DEMO_STORE_LINK === 'true'
        ? `https://${DEMO_HOSTS.qamar ?? 'storedemo'}${BRAND.domains.storeSuffix}`
        : null,
  };
}

/**
 * The slug a visitor could claim from a 404 on `<slug>.ebda.app`: the host's single label when it is a
 * valid store slug that is not reserved, a protected brand or a demo-showroom name. `null` for custom
 * domains, the platform host, IPs and anything else (no CTA). Availability is NOT asserted here: the
 * signup flow checks it live and says so; this only avoids offering a name signup would refuse outright.
 */
export function signupSlugForHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const bare = host.split(':')[0].toLowerCase().replace(/\.$/, '');
  const suffix = BRAND.domains.storeSuffix;
  if (!bare.endsWith(suffix)) return null;
  const label = bare.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;
  const valid = validateStoreSlug(label);
  return valid.ok ? valid.slug : null;
}

/** Signup with the name prefilled; the onboarding store step reads it back (it still checks availability). */
export function signupUrlForSlug(slug: string): string {
  return `${BRAND_STORE_APP_URL}/signup?slug=${encodeURIComponent(slug)}`;
}
