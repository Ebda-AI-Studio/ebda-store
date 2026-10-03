import type { InngestFunction } from 'inngest';
import { inngest } from '../client';
import { DomainClaimService } from '../../../services/domain-claim.service';
import { resolveDomainService } from '../../../services/domain-provider';

/**
 * Custom-domain claim sweep (SP5 task 4) - every 15 minutes.
 *
 * A custom domain is only a CLAIM until the provider (Cloudflare for SaaS)
 * reports the hostname verified (DCV). This promotes every pending claim that
 * has become verified to the store's served `domain`, marks the ones the
 * provider gave up on `failed`, and RELEASES every pending/failed claim older
 * than DOMAIN_CLAIM_TTL_HOURS (72h) - freeing the hostname at the provider so
 * the real owner can attach it (a squatter cannot hold a name forever).
 *
 * Idempotent and safe to re-run: each store's transition is a guarded
 * `updateMany` keyed on the exact pending value, and the provider calls are
 * read-only except the release, which is a no-op for an already-gone hostname.
 */
export const domainClaimSweep: InngestFunction.Any = inngest.createFunction(
  {
    id: 'domain-claim-sweep',
    name: 'Verify and release pending custom-domain claims',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) => {
    return step.run('sweep', () => DomainClaimService.sweep(resolveDomainService()));
  }
);
