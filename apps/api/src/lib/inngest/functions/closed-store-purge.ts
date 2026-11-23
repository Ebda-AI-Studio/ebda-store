import type { JobDef } from '../../jobs/types';
import { inngest } from '../client';
import { closedStorePurgePorts } from '../../closed-store-purge-adapters';
import { purgeIsLive, runClosedStorePurge } from '../../closed-store-purge';
import logger from '../../logger';

/**
 * Closed-store purge (Ruling NZ-D15B, plan N-24), daily. DRY RUN unless `CLOSED_STORE_PURGE_LIVE=true` AND the date is on or after
 * PURGE_DRY_RUN_UNTIL (30 days after the ruling): it then exports + verifies but wipes nothing. Live, it wipes only stores that are
 * past their retention clock, were noticed NOTICE_DAYS ago, and whose archive read back identical. Every abort is a P1 alert.
 * One idempotent unit, no `step.run`; a failure of one store never stops the next (the core catches per store).
 */
export const closedStorePurge: JobDef = inngest.createFunction(
  {
    id: 'closed-store-purge',
    name: 'Purge closed stores past retention (export, verify, wipe; dry run by default)',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '17 2 * * *' }],
  },
  async () => {
    const now = Date.now();
    const live = purgeIsLive(process.env, now);
    const results = await runClosedStorePurge(closedStorePurgePorts(), { now, live });
    const tally = results.reduce<Record<string, number>>(
      (m, r) => ((m[r.outcome] = (m[r.outcome] ?? 0) + 1), m),
      {}
    );
    logger.info({ live, stores: results.length, tally }, '[closed-store-purge] run');
    return { live, tally };
  }
);
