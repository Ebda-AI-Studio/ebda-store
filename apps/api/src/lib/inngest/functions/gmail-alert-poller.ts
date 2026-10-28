import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { pollGmailAlerts } from '../../../services/gmail-alert-poller.service';

/**
 * Hourly (Ruling INNGEST-BUDGET-1) Gmail IMAP poller. Forwards alert emails from
 * Sentry / BetterStack / PostHog / UptimeRobot / Vercel / Railway
 * into the internal Telegram pipeline via sendAlert().
 *
 * Why cron-not-realtime: external services don't expose webhooks on
 * their free tiers, but they all send free email alerts. Polling at
 * 5-min granularity is "good enough" for P1 ops — P0 events are
 * already direct via the existing in-API alerts.service call sites
 * (payment HMAC, Inngest dead-letter, health degraded, uncaught).
 *
 * retries=1 because IMAP can flake under transient network. quota:
 * one Inngest invocation per hour = 24/day.
 */
export const gmailAlertPoller: JobDef = inngest.createFunction(
  {
    id: 'gmail-alert-poller',
    name: 'Poll Gmail for external-service alerts → forward to Telegram',
    retries: 1,
    // CADENCE NOTE (2026-08-09) — this is a COST control, not a preference.
    //
    // Neon suspends a compute after 5 minutes idle. Anything polling the database
    // every 5 minutes therefore resets the idle timer just before it fires, and the
    // compute NEVER sleeps. Measured: a previous project ran 195 active hours out of 195 and
    // burned 193 CU-h/month — 76% of the whole account allowance — while the menu
    // projects, which idle normally, used 7-17.
    //
    // gmail-alert-poller is threshold-driven: it looks for rows stale by
    // inbox-poll (no DB threshold) minutes, so polling every 5 was oversampling it. At */15 the worst-case
    // detection window moves from 5-5 to 15-15 minutes, and the database gets a
    // ~10 minute sleep gap every cycle.
    //
    // Do NOT tighten this back to */5 without re-checking the Neon bill: the whole
    // saving comes from leaving a gap LONGER than the 300s suspend timeout.
    // HOURLY (Ruling INNGEST-BUDGET-1). Not served on Workers (see functions/index.ts); the budget test counts it anyway.
    triggers: [{ cron: '7 * * * *' }], // hourly
  },
  async () => {
    try {
      const result = await pollGmailAlerts();
      return { ok: true, ...result };
    } catch (err) {
      logger.error({ err }, 'gmail-alert-poller inngest run failed');
      throw err;
    }
  }
);
