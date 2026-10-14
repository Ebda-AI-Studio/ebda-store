/**
 * PROVIDERS-2: may this provider be enabled / offered at all?
 *
 * A provider is usable when the catalog lists it as manual (COD, InstaPay) or as verified against
 * its real sandbox. Unverified gateways are "coming soon" for every merchant and super admin.
 *
 * PROVIDERS-ACTIVATION: a provider is ALSO usable for ONE store once a super admin activated it
 * for that store (`provider_activation_requests.status = 'activated'`, set only after that
 * store's own Test connection passed). `isProviderUsableForStore` is the answer every enable gate
 * and the runtime offer use: catalog-verified OR store-activated. The catalog-only
 * `isProviderUsable` stays for callers with no store.
 *
 * `PAYMENT_PROVIDERS_ALLOW_UNVERIFIED=1` lifts the gate for the local stub suites and for
 * `scripts/provider-sandbox-check.mjs`, and ONLY outside production: in production it is ignored,
 * so no environment variable can put an unverified gateway in front of a paying customer.
 */
import { getProviderEntry, isProviderSelectable } from '@ebda/shared';
import { prisma, withStore } from '@ebda/database';

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

/** The providers a super admin activated for this store (a read inside the store's scope). */
export async function activatedProvidersForStore(storeId: string): Promise<Set<string>> {
  const rows = await withStore(storeId, () =>
    prisma.providerActivationRequest.findMany({
      where: { storeId, status: 'activated' },
      select: { provider: true },
    })
  );
  return new Set(rows.map(r => r.provider));
}

/** PROVIDERS-ACTIVATION: has a super admin activated this provider for this store? */
export async function isProviderActivatedForStore(storeId: string, code: string): Promise<boolean> {
  return (await activatedProvidersForStore(storeId)).has(code);
}

/** Catalog-verified OR activated for this store. The gate every enable path and the offer use. */
export async function isProviderUsableForStore(code: string, storeId: string): Promise<boolean> {
  if (isProviderUsable(code)) return true;
  if (!getProviderEntry(code)) return false;
  return isProviderActivatedForStore(storeId, code);
}
