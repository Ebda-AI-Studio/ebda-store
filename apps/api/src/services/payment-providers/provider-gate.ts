/**
 * May this provider be enabled / offered at all?
 *
 * Ruling PROVIDERS-3 (Ahmad 2026-10-24): there are no provider test accounts, the first merchant's
 * own credentials are the verification. So EVERY provider in the catalog may be connected and
 * enabled, `verified` or not. What protects the merchant (and us) is not a catalog flag but the
 * connection check: a provider is enabled only after a passing Test connection of exactly the
 * stored credentials (`connectionTestIsCurrent`), and the first real use of an unverified provider
 * pages ops (`provider-verification.service.ts`).
 *
 * Supersedes PROVIDERS-2 (unverified = "coming soon" for everyone) and PROVIDERS-ACTIVATION as a
 * gate: a store activation (`provider_activation_requests.status = 'activated'`) is still readable
 * here for old rows, but nothing requires it any more.
 */
import { getProviderEntry } from '@ebda/shared';
import { prisma, withStore } from '@ebda/database';
import { getProviderV2 } from './registry';

export function isProviderUsable(code: string): boolean {
  return getProviderEntry(code) !== undefined;
}

/**
 * Ruling GEIDEA-2: may a BUYER pay with this provider at checkout? A gateway Ebda can never CONFIRM
 * (no verifiable webhook and no remote status API: `capabilities.webhooks` and `remoteStatus` both
 * false) is hidden from buyers, because a payment Ebda cannot confirm is a fail-open on the money
 * path. Merchants may still connect it in admin ("pending verification"). It is switched on per
 * store, the moment the provider confirms its callback format, by the operator flag
 * `CHECKOUT_UNCONFIRMED_PROVIDERS="<provider>:<storeId>,..."` (`<provider>:*` = every store).
 * Manual providers (COD, InstaPay) have a human confirmation and are always offerable.
 */
export function isOfferableAtCheckout(code: string, storeId?: string | null): boolean {
  const entry = getProviderEntry(code);
  if (!entry) return false;
  if (entry.manual) return true;
  const caps = getProviderV2(code)?.capabilities;
  if (!caps) return false;
  if (caps.webhooks || caps.remoteStatus) return true;
  const flags = (process.env.CHECKOUT_UNCONFIRMED_PROVIDERS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return flags.some(f => f === `${code}:*` || (storeId ? f === `${code}:${storeId}` : false));
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

/** Any catalog provider (PROVIDERS-3); an unknown code stays unusable. */
export async function isProviderUsableForStore(code: string, storeId: string): Promise<boolean> {
  void storeId;
  return isProviderUsable(code);
}
