import type { JobDef } from '../../jobs/types';
import { runInStoreScope } from '@ebda/database';
import logger from '../../logger';
import { inngest } from '../client';
import { decideAndActivate } from '../../../services/billing/instapay-auto-confirm.service';

/**
 * InstaPay auto-confirm (Ruling INSTAPAY-AUTO-1, plan S5): decide one subscription claim and, when the receipt fully matches and the
 * switches are `live`, activate it through the same ledger path as the human. Idempotent end to end (the decision row is keyed on the
 * receipt), so a retry or a replayed event never re-decides and never re-activates. Runs under a STORE SCOPE: no transaction is held
 * across the model-free decision. `retries: 2` only re-runs a step that THREW (a database blip); a decided claim is a no-op.
 */
export const instapayAutoConfirm: JobDef = inngest.createFunction(
  {
    id: 'instapay-auto-confirm',
    name: 'InstaPay: auto-confirm a matching subscription receipt',
    retries: 2,
    concurrency: { limit: 3, key: 'event.data.storeId' },
    triggers: [{ event: 'instapay/auto-confirm.requested' }],
  },
  async ({ event, step }) => {
    const { storeId, claimId } = (event.data ?? {}) as { storeId?: string; claimId?: string };
    if (!storeId || !claimId) {
      logger.warn({ data: event.data }, 'instapayAutoConfirm: missing ids');
      return { skipped: 'missing-ids' };
    }
    const out = await step.run('decide', () =>
      runInStoreScope(storeId, () => decideAndActivate({ storeId, claimId }))
    );
    return { storeId, claimId, state: out.state, reasons: out.reasons };
  }
);
