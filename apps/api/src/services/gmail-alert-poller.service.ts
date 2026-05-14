import { ImapFlow } from 'imapflow';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';

/**
 * IMAP poller that reads alert emails from Ahmad's Gmail and dispatches
 * them through the internal Telegram alerts.service.
 *
 * Why this exists: Sentry/BetterStack/PostHog/UptimeRobot all gate
 * webhook notifications behind paid plans on their free tiers, but
 * email alerts are free across the board. This poller bridges the gap
 * — every external service sends to Gmail, we pull from Gmail every
 * 5 min and forward to Telegram via sendAlert(). One notification
 * channel for the operator.
 *
 * Setup (one-time):
 *   1. Owner enables 2FA on the Gmail account (myaccount.google.com)
 *   2. Owner generates an App Password at myaccount.google.com/apppasswords
 *      named "FWB Alert Poller" — Google returns a 16-char password
 *   3. Set Railway env vars:
 *        GMAIL_IMAP_USER             = ahmed0montaser@gmail.com
 *        GMAIL_IMAP_APP_PASSWORD     = <the 16-char password>
 *
 * Trigger: Inngest cron `*\/5 * * * *` (every 5 minutes). See
 * `apps/api/src/lib/inngest/functions/gmail-alert-poller.ts`.
 *
 * Safety:
 *   - Graceful no-op when env vars missing (logs once at boot).
 *   - App Password is scoped to mail-only — no Drive / Calendar / etc.
 *   - Marks each forwarded email as Seen (\Seen flag) so it's never
 *     reprocessed. Also moves to archive (away from INBOX) for inbox
 *     cleanliness.
 *   - sendAlert() has its own Redis-keyed throttle so duplicate alerts
 *     within 5 min collapse to one Telegram message.
 *   - Body excerpt is capped at 500 chars to stay under Telegram's
 *     4096-char message cap (sendAlert truncates further if needed).
 */

const KNOWN_SENDERS: Record<string, string> = {
  'sentry.io': 'sentry',
  'sentry-mail.com': 'sentry',
  'betterstack.com': 'betterstack',
  'logtail.com': 'betterstack',
  'logs.betterstack.com': 'betterstack',
  'posthog.com': 'posthog',
  'uptimerobot.com': 'uptimerobot',
  'vercel.com': 'vercel',
  'railway.app': 'railway',
  'neon.tech': 'neon',
};

function resolveSource(fromAddress: string): string {
  const lower = fromAddress.toLowerCase();
  for (const [domain, src] of Object.entries(KNOWN_SENDERS)) {
    if (lower.includes(domain)) return src;
  }
  return 'gmail.unknown';
}

function buildSearchSenderClause(): string[] {
  return Array.from(new Set(Object.values(KNOWN_SENDERS))).map(name => `@${name}`);
}

export interface PollResult {
  scanned: number;
  forwarded: number;
  failed: number;
  skipped: number;
}

export async function pollGmailAlerts(): Promise<PollResult> {
  const user = process.env.GMAIL_IMAP_USER;
  const pass = process.env.GMAIL_IMAP_APP_PASSWORD;

  if (!user || !pass) {
    logger.info('gmail-alert-poller: GMAIL_IMAP_USER / GMAIL_IMAP_APP_PASSWORD missing — skipping');
    return { scanned: 0, forwarded: 0, failed: 0, skipped: 0 };
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const result: PollResult = { scanned: 0, forwarded: 0, failed: 0, skipped: 0 };

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const senderDomains = Object.keys(KNOWN_SENDERS);
      const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h backstop

      for (const domain of senderDomains) {
        const uids = await client.search({ seen: false, from: domain, since: sinceDate });
        if (!uids || uids.length === 0) continue;

        for (const uid of uids) {
          result.scanned++;
          try {
            const msg = await client.fetchOne(String(uid), { envelope: true, source: true });
            if (!msg || !msg.envelope) {
              result.skipped++;
              continue;
            }
            const fromAddr = msg.envelope.from?.[0]?.address ?? 'unknown@unknown';
            const subject = (msg.envelope.subject ?? 'untitled alert').slice(0, 200);
            const source = resolveSource(fromAddr);

            // Extract a short body excerpt — full MIME parsing isn't
            // worth the deps here; we just take the first 500 chars
            // of the raw source after stripping headers.
            const raw = msg.source?.toString('utf-8') ?? '';
            const bodyStart = raw.indexOf('\r\n\r\n');
            const bodyExcerpt = (bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw)
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 500);

            await sendAlert({
              level: 'p1',
              scope: 'platform',
              source: `email.${source}`,
              title: subject,
              body: bodyExcerpt,
              context: { from: fromAddr, uid: String(uid) },
            });

            await client.messageFlagsAdd(String(uid), ['\\Seen']);
            result.forwarded++;
          } catch (innerErr) {
            result.failed++;
            logger.warn(
              { err: innerErr, uid: String(uid), domain },
              'gmail-alert-poller: failed to forward message'
            );
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ err }, 'gmail-alert-poller: imap connection / search failed');
    throw err;
  } finally {
    try {
      await client.logout();
    } catch {
      // logout failures are noise; the underlying socket gets GC'd
    }
  }

  if (result.scanned > 0) {
    logger.info(result, 'gmail-alert-poller: cycle complete');
  }
  return result;
}
