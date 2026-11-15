/**
 * Claim, keep or clear a store's custom domain. The one implementation behind `PUT /stores/:id/domain` (routes/store.routes.ts) and the
 * assistant's `domain_connect` tool. A claim is NOT an active domain: see services/domain-claim.service.ts for the lifecycle.
 */
import { prisma, withStore } from '@ebda/database';
import { parseStoreHost } from '@ebda/shared';
import { config } from '../config';
import { storeUpdate } from '../lib/repo-factory';
import { DomainClaimService, normalizeDomain } from './domain-claim.service';
import { resolveDomainService, type DomainProvider } from './domain-provider';
import { assertWithinLimit } from './plan-limit.service';
import { StoreService } from './store.service';

/** A refusal the route turns into the same `{ success: false, error: { code, message } }` it always answered. */
export class DomainChangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'DOMAIN_INVALID' | 'DOMAIN_FEATURE_UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'DomainChangeError';
  }
}

/** The merchant-typed hostname in its stored form, or the route's DOMAIN_INVALID refusal (Ebda's own hosts, IPs and malformed names can never be claimed). */
export function parseCustomDomain(raw: string | null): string | null {
  const domain = raw ? normalizeDomain(raw) : null;
  if (domain && parseStoreHost(domain).kind !== 'custom') {
    throw new DomainChangeError(
      400,
      'DOMAIN_INVALID',
      'Enter your own domain (for example mystore.com), not an Ebda Store address.'
    );
  }
  return domain;
}

/** The records the merchant must add at the registrar when the provider cannot be reached (the route's own fallback). */
export const fallbackDnsRecords = (domain: string) => [
  { type: 'CNAME', name: domain, value: config.cfFallbackOrigin },
];

/** What the store holds now: the verified domain, an unverified claim and its status. */
export async function readStoreDomainState(storeId: string) {
  const row = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { domain: true, pendingDomain: true, domainStatus: true },
    })
  );
  if (!row) throw new Error('store not found');
  return row;
}

export async function setStoreDomain(
  storeId: string,
  rawDomain: string | null
): Promise<{
  claimState: 'pending' | 'active' | null;
  domain: string | null;
  provider: DomainProvider;
}> {
  const store = await StoreService.getById(storeId); // 404s an unknown store before anything else
  const domain = parseCustomDomain(rawDomain);
  const oldDomain = store.domain;
  const previous = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { domainProvider: true } })
  );
  const domainSvc = resolveDomainService({ domainProvider: previous?.domainProvider });

  let claimState: 'pending' | 'active' | null = null;
  if (domain && domain !== oldDomain) {
    // Plan gate (SP5): attaching a new domain is a plan capability; clearing or keeping one is always allowed.
    await assertWithinLimit(storeId, 'customDomain');
    if (!domainSvc.isConfigured()) {
      throw new DomainChangeError(
        503,
        'DOMAIN_FEATURE_UNAVAILABLE',
        'Custom domain feature is not configured on this platform. Please contact support.'
      );
    }
    // Uniqueness (active elsewhere / fresh pending elsewhere -> DOMAIN_TAKEN), provider add, and the pending claim row. The old
    // active domain keeps serving until the new one is VERIFIED (the sweep / status poll promotes it).
    const claim = await DomainClaimService.claim(storeId, domain, domainSvc);
    claimState = claim.state === 'active' ? 'active' : 'pending';
  } else if (domain && domain === oldDomain) {
    // Re-saving the verified domain: nothing to claim; drop any other pending claim.
    await DomainClaimService.cancelPending(storeId, domainSvc);
    claimState = 'active';
  } else {
    // Clearing: drop the verified domain AND any pending claim.
    await DomainClaimService.cancelPending(storeId, domainSvc);
    if (oldDomain) {
      await storeUpdate(prisma, {
        where: { id: storeId },
        data: { domain: null, domainStatus: null, domainVerifiedAt: null },
      });
      await DomainClaimService.afterDomainChanged({
        storeId,
        slug: store.slug,
        oldDomain,
        newDomain: null,
        provider: domainSvc,
      });
    }
  }
  return { claimState, domain, provider: domainSvc };
}
