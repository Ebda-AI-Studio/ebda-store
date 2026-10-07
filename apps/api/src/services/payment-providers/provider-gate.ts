/**
 * PROVIDERS-2: may this provider be enabled / offered at all?
 *
 * A provider is usable when the catalog lists it as manual (COD, InstaPay) or as verified against
 * its real sandbox. Unverified gateways are "coming soon" for every merchant and super admin.
 *
 * `PAYMENT_PROVIDERS_ALLOW_UNVERIFIED=1` lifts the gate for the local stub suites and for
 * `scripts/provider-sandbox-check.mjs`, and ONLY outside production: in production it is ignored,
 * so no environment variable can put an unverified gateway in front of a paying customer.
 */
import { getProviderEntry, isProviderSelectable } from '@force/shared';

export function unverifiedProvidersAllowed(): boolean {
  return (
    process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED === '1' && process.env.NODE_ENV !== 'production'
  );
}

export function isProviderUsable(code: string): boolean {
  const entry = getProviderEntry(code);
  if (!entry) return false;
  return isProviderSelectable(entry) || unverifiedProvidersAllowed();
}
