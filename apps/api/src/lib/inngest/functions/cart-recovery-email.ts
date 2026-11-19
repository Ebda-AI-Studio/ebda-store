import type { JobDef } from '../../jobs/types';
import { runInTenantContext } from '@ebda/database';
import { storeRepo } from '../../repo-factory';
import logger from '../../logger';
import { inngest } from '../client';
import { deliverCartRecoveryEmail } from '../../../services/cart-recovery-email.service';

/**
 * Abandoned-cart recovery email sender. Plan: docs/plans/done/2026-10-21-cart-email-campaigns.md.
 *
 * Triggered ONLY by `cart-recovery/email-requested`, which only
 * `sweepCartRecoveryEmails` (cron, via abandonedCartService.process) emits for a cart it has
 * just claimed (`email_status` NULL -> 'queued'). The event id is the cart, so Inngest dedupes
 * a duplicate emit too. Every send-time check (channel on, plan feature, cart not converted,
 * newsletter consent) lives in `deliverCartRecoveryEmail`; a transient failure (Resend rate
 * limit, no send slot) throws so the step retries, a permanent one marks the row `failed`.
 * `onFailure` marks a still-`queued` row `failed` so no cart is left queued forever.
 */
type EventData = { abandonedCartId?: string; storeId?: string };

const cartRecoveryEmailFn = inngest.createFunction(
  {
    id: 'cart-recovery-email',
    name: 'Abandoned cart: send the recovery email',
    // A store's reminders queue behind each other; the platform send pacer bounds the rest.
    concurrency: { limit: 2, key: 'event.data.storeId' },
    retries: 4,
    triggers: [{ event: 'cart-recovery/email-requested' }],
    onFailure: async ({ event }) => {
      const { abandonedCartId, storeId } = (event?.data?.event?.data ?? {}) as EventData;
      if (!abandonedCartId || !storeId) return;
      // PORTED (Ruling CF-R4-5): the row is the store's own, on whichever backend serves it
      const repo = await storeRepo(storeId);
      const mark = () =>
        repo.writer.abandonedCart.updateMany({
          where: { id: abandonedCartId, storeId, emailStatus: 'queued' },
          data: { emailStatus: 'failed', emailDetail: 'SEND_JOB_FAILED' },
        });
      const r = await (repo.backend === 'do' ? mark() : runInTenantContext(storeId, mark));
      logger.error({ abandonedCartId, storeId, marked: r.count }, '[CartEmail] send job failed');
    },
  },
  async ({ event, step }) => {
    const { abandonedCartId, storeId } = (event.data ?? {}) as EventData;
    if (!abandonedCartId || !storeId) {
      logger.warn('[CartEmail] cart-recovery/email-requested without ids - skipping');
      return { skipped: 'missing-ids' };
    }
    return step.run('deliver', () => deliverCartRecoveryEmail(storeId, abandonedCartId));
  }
);

export const cartRecoveryEmail: JobDef = cartRecoveryEmailFn;
