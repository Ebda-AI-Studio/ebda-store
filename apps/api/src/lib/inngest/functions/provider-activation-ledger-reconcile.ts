import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { reconcileUnledgeredEnables } from '../../../services/provider-activation.service';

/**
 * Money review M3 of #782: every enabled API payment / shipping provider must have its activation ledger row. A super-
 * admin enable whose ledger write AND switch-off both failed pages ops at once; this daily run keeps reporting any such
 * provider (P1) until someone switches it off or records the activation. Read-only: it never switches a provider off.
 */
export const providerActivationLedgerReconcile: JobDef = inngest.createFunction(
  {
    id: 'provider-activation-ledger-reconcile',
    name: 'Report enabled providers with no activation ledger row',
    retries: 1,
    concurrency: { limit: 1 },
    // an existing daily Cron Trigger (wrangler.jsonc): no new schedule to deploy
    triggers: [{ cron: '0 4 * * *' }],
  },
  // one idempotent read-only unit: no step wrapper (each step is a second billed execution)
  async () => ({ missing: (await reconcileUnledgeredEnables()).length })
);
