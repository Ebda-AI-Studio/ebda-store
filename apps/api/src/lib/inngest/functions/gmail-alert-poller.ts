import type { InngestFunction } from 'inngest';
import logger from '../../logger';
import { inngest } from '../client';
import { pollGmailAlerts } from '../../../services/gmail-alert-poller.service';

/**
 * Every-5-minutes Gmail IMAP poller. Forwards alert emails from
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
 * one Inngest invocation per 5 min = 288/day, well under free-tier.
 */
export const gmailAlertPoller: InngestFunction.Any = inngest.createFunction(
  {
    id: 'gmail-alert-poller',
    name: 'Poll Gmail for external-service alerts → forward to Telegram',
    retries: 1,
    triggers: [{ cron: '*/5 * * * *' }],
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
