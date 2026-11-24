import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { stepRunUnlessEmpty } from '../empty-exit';
import { runAutoDigest } from '../../../services/billing/instapay-auto-confirm.service';

/**
 * InstaPay auto-confirm daily digest (Ruling INSTAPAY-AUTO-1, plan S8): ONE Telegram message a day to Ahmad through the OS brain, listing
 * every automatically confirmed payment with a one-tap "not received". 07:00 UTC = 09:00 Cairo outside daylight saving (10:00 in summer);
 * the hour is not load-bearing, the once-a-day cadence is. Platform tables only; on a day with nothing to list the un-stepped probe exits
 * as ONE execution (Ruling INNGEST-BUDGET-1), so this adds one small run a day and no new database wake-up beyond it.
 */
export const instapayAutoDigest: JobDef = inngest.createFunction(
  {
    id: 'instapay-auto-digest',
    name: 'InstaPay: daily auto-confirm digest to Ahmad',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 7 * * *' }],
  },
  async ({ step }) => {
    const out = await stepRunUnlessEmpty(step, 'digest', async () => [await runAutoDigest()]);
    return out[0] ?? { listed: 0, stamped: 0, reminded: 0 };
  }
);
