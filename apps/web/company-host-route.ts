/**
 * Pure routing decision for the Ebda COMPANY-page carve-out.
 *
 * This Worker owns the WHOLE `ebda.app` zone (SaaS wildcard route), so it
 * sees EVERY host: the company apex, `store/admin/orders.ebda.app`, and every
 * merchant custom domain (demo-store.example, demo-shop.example, …). This helper decides
 * what to do based ONLY on the hostname, with no side effects, so the routing
 * contract is unit-testable in isolation from the (heavy) Next handler.
 *
 * Contract — ONLY the two exact company hosts are ever intercepted:
 *   - `ebda.app` → 301 redirect to the bare apex (single canonical host)
 *   - `ebda.app`     → reverse-proxy to the Pages company site
 *   - anything else (store/admin/orders subdomains, `/<slug>`, EVERY merchant
 *     domain) → `next`, i.e. fall through to the Next storefront UNCHANGED.
 */
import { BRAND } from '@force/shared';

export const COMPANY_APEX: string = BRAND.domains.marketing;
/** Pages project that serves the marketing site (SP9 creates it). */
export const COMPANY_ORIGIN = 'https://ebda-marketing.pages.dev';

export type CompanyRoute =
  | { kind: 'redirect'; location: string; status: 301 }
  | { kind: 'proxy'; origin: string }
  | { kind: 'next' };

export function companyHostRoute(hostname: string, pathname: string, search: string): CompanyRoute {
  // Canonicalise the company page to the bare apex: www → apex (permanent).
  if (hostname === `www.${COMPANY_APEX}`) {
    return {
      kind: 'redirect',
      location: `https://${COMPANY_APEX}${pathname}${search}`,
      status: 301,
    };
  }
  // Company apex → reverse-proxy to the Pages company site.
  if (hostname === COMPANY_APEX) {
    return { kind: 'proxy', origin: COMPANY_ORIGIN };
  }
  // Everything else (all merchant domains + platform subdomains) → Next, unchanged.
  return { kind: 'next' };
}
