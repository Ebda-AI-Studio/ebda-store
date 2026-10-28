import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';

/**
 * Hourly heartbeat. Doesn't do anything useful on its own — exists
 * as a continuous green-run in the Inngest dashboard so we can
 * tell at a glance whether the SDK is healthy and the platform is
 * still reaching our endpoint. If hourly heartbeats stop, something
 * is wrong with the inngest infrastructure even if no business
 * events are firing.
 *
 * Free tier permits cron-triggered functions; this is a no-op so
 * it doesn't burn any meaningful quota.
 */
export const heartbeat: JobDef = inngest.createFunction(
  {
    id: 'heartbeat',
    name: 'Hourly heartbeat',
    retries: 0,
    triggers: [{ cron: '0 * * * *' }],
  },
  async () => {
    logger.info({ at: new Date().toISOString() }, 'inngest heartbeat');
    return { ok: true };
  }
);
