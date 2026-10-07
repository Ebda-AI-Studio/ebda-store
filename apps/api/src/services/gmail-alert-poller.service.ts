import { ImapFlow } from 'imapflow';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
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
  'axiom.co': 'axiom',
  // 2026-06-29: deploys moved to Cloudflare Workers Builds — add CF + GitHub
  // so build/deploy failures land in Telegram alongside Sentry/Vercel/Railway.
  'cloudflare.com': 'cloudflare',
  'notify.cloudflare.com': 'cloudflare',
  'github.com': 'github',
};

/**
 * Sender-address allowlist — only forward emails from these specific
 * sub-addresses, not just any address on the domain. Marketing senders
 * (help@sentry.io, hello@posthog.com, marketing@vercel.com, …) live on
 * the same root domain as alert senders (notifications@, alerts@, …)
 * but emit onboarding/trial/upsell mail we explicitly DON'T want
 * forwarding to Telegram as P1 alerts.
 *
 * Format: `key = sender-domain (matches KNOWN_SENDERS), value = array
 * of allowed local-parts (case-insensitive substring). Empty array
 * means "any address on the domain is fine" — useful for services
 * where only one sender exists (uptimerobot).
 */
const ALLOWED_LOCAL_PARTS: Record<string, string[]> = {
  sentry: ['notifications', 'alerts', 'no-reply@sentry'], // explicit alert addresses only
  betterstack: ['alerts', 'incidents', 'notifications'],
  posthog: ['notifications', 'alerts'], // never hello@/help@/marketing@
  // 2026-05-15: tightened from [] (allow-any) — uptimerobot promo emails
  // come from `support@user.uptimerobot.com` (marketing subdomain). real
  // alerts come from `noreply@uptimerobot.com` or `alerts@uptimerobot.com`.
  // note: ahmad receives uptimerobot alerts via mobile push, not email —
  // so email-side filtering can be strict.
  uptimerobot: ['noreply', 'notifications', 'alerts'],
  vercel: ['alerts', 'notifications', 'security'], // skip noreply@vercel.com onboarding
  railway: ['alerts', 'notifications'], // skip team@railway.app
  neon: ['alerts', 'notifications'], // skip team@neon.tech
  axiom: ['alerts', 'notifications', 'monitors'],
  // 2026-06-29: CF Workers Builds emails come from noreply@notify.cloudflare.com
  // and noreply@cloudflare.com. GitHub CI-failure emails come from
  // noreply@github.com / notifications@github.com. Both use [] to match any
  // address on their domains — each sender is single-purpose (no marketing
  // emails share the same address pattern).
  cloudflare: ['noreply', 'notifications', 'alerts'],
  github: ['noreply', 'notifications'],
};

/**
 * Subject-line denylist — drop emails whose subject matches any of
 * these patterns regardless of sender, because they're typically
 * onboarding / trial / billing / feature-announce noise the operator
 * doesn't need on Telegram. The poller still marks these as \Seen so
 * they don't re-fire on the next cycle.
 */
const SUBJECT_NOISE_PATTERNS = [
  /welcome\s+to/i,
  /trial\s+(starts|ends|expires|extended)/i,
  /your\s+(free\s+)?trial/i,
  /verify\s+your\s+email/i,
  /confirm\s+your\s+(email|account)/i,
  /getting\s+started/i,
  /onboard(ing)?/i,
  /\bnewsletter\b/i,
  /\bdigest\b/i,
  /pricing\s+(change|update)/i,
  /billing\s+(reminder|update)/i,
  /upgrade\s+to/i,
  /new\s+feature/i,
  /weekly\s+(report|summary)/i,
  /monthly\s+(report|summary)/i,
  /tips?\s+(and|&)\s+tricks/i,
  // 2026-05-15: promo/discount language additions — surfaced by an
  // uptimerobot "Get 25% OFF UptimeRobot upgrades!" email that slipped
  // through. these patterns catch percentage discounts, limited-time
  // offers, and generic save/sale promos.
  /\d{1,3}\s?%\s+off\b/i, // "25% OFF", "25 % OFF", "25%off"
  /\blimited[\s-]?time\b/i, // "limited time", "limited-time"
  /\bdiscount\b/i,
  /\bsave\s+\$?\d+/i, // "save 25", "save $50", "save 25%"
  /\bspecial\s+offer\b/i,
  /\bpromo(tion)?\b/i,
  /\bsale\b/i,
  /\bdeal\b/i,
  /upgrade\s+(your|now|today)/i, // "upgrade your account", "upgrade now"
  /\bcoupon\b/i,
];

function resolveSource(fromAddress: string): string {
  const lower = fromAddress.toLowerCase();
  for (const [domain, src] of Object.entries(KNOWN_SENDERS)) {
    if (lower.includes(domain)) return src;
  }
  return 'gmail.unknown';
}

/**
 * Project-identification markers used to tag forwarded Telegram alerts
 * with `[<ProjectTag>] <subject>` so Ahmad knows which project the email
 * came from (Ahmad 2026-05-17 night: "all projects do send there the
 * email have details about the platform and project name, include them
 * so i know which project").
 *
 * Order matters — first match wins. Most specific first (FWB-API before
 * FWB-Web before FWB, etc.) so a Sentry email mentioning both
 * `force-website-builder` and `api` lands as FWB-API not bare FWB.
 *
 * Senders that follow the `[<Project Name>] <Title>` subject convention
 * (Sentry, Vercel, PostHog, Neon) get caught by the bracket-prefix step
 * in `extractProject` first; this list is the fallback for senders that
 * embed the project name in body text only (Axiom alerts, Railway
 * deployment notifications, BetterStack incidents).
 */
const PROJECT_MARKERS: Array<{ tag: string; patterns: RegExp[] }> = [
  // FWB sub-projects — match BEFORE plain FWB so the most specific tag wins
  {
    tag: 'FWB-API',
    patterns: [/force-website-builder.*api/i, /api\.ebda\.app/i, /api-production-c058/i],
  },
  { tag: 'FWB-Admin', patterns: [/force-admin/i, /\badmin\.ebda\.app/i] },
  {
    tag: 'FWB-Web',
    patterns: [/force-web\b/i, /wadyaljuz/i, /\bebda\.app/i, /force-web-sigma/i],
  },
  { tag: 'FWB', patterns: [/force-website-builder/i, /\bfwb\b/i] },
  // Other Force projects
  {
    tag: 'WBS',
    patterns: [/whatsapp.?saas/i, /whatsapp.?bulk/i, /\bwhatsapp\.ebda\.app/i, /\bwbs\b/i],
  },
  { tag: 'CRM', patterns: [/force.media.crm/i, /\bcrm\.ebda\.app/i] },
  { tag: 'Landing', patterns: [/force.media.landing/i, /^www\.ebda\.app/i] },
  { tag: 'OmHassan', patterns: [/om.?hassan/i] },
];

/**
 * Extract a short project tag from an email's subject + body. Returns
 * `null` when no marker matches — caller falls back to the raw subject.
 *
 * Two-pass strategy:
 *  1. Parse the bracketed prefix Sentry/Vercel/PostHog use
 *     (`[force-web] Build failed`) → match against PROJECT_MARKERS;
 *     if no map hit, return the literal bracket contents (truncated)
 *     so unknown-project alerts still surface a hint.
 *  2. Scan the first 1KB of subject+body for any marker pattern —
 *     catches senders that put the project name in body text only.
 */
function extractProject(subject: string, body: string): string | null {
  // 1. Bracketed-prefix path. Sentry: `[force-website-builder/api] ...`
  //    Vercel:  `[force-web] Build failed`
  //    PostHog: `[Ebda] Insight...`
  const bracketMatch = subject.match(/^\s*\[([^\]]+)\]/);
  if (bracketMatch) {
    const inBracket = bracketMatch[1];
    for (const { tag, patterns } of PROJECT_MARKERS) {
      if (patterns.some(rx => rx.test(inBracket))) return tag;
    }
    // Unknown bracket — return literal (truncated) so we don't lose the hint
    return inBracket.length > 24 ? inBracket.slice(0, 24) : inBracket;
  }

  // 2. Body-scan fallback. First 1KB covers most service templates.
  const haystack = `${subject} ${body}`.slice(0, 1000);
  for (const { tag, patterns } of PROJECT_MARKERS) {
    if (patterns.some(rx => rx.test(haystack))) return tag;
  }
  return null;
}

/**
 * Decide whether an email is actually an alert worth forwarding.
 * Returns `true` to forward, `false` to skip (and mark \Seen so it
 * doesn't keep re-firing on every cron tick).
 */
function isAlertEmail(source: string, fromAddress: string, subject: string): boolean {
  // Subject-line denylist applies regardless of sender.
  if (SUBJECT_NOISE_PATTERNS.some(rx => rx.test(subject))) return false;

  // Sender-address allowlist — if the service has known alert addresses
  // configured, the from-address must contain one of them.
  const allowedParts = ALLOWED_LOCAL_PARTS[source];
  if (allowedParts === undefined) return true; // unknown source — let it through
  if (allowedParts.length === 0) return true; // single-sender service — any address is fine
  const fromLower = fromAddress.toLowerCase();
  return allowedParts.some(part => fromLower.includes(part.toLowerCase()));
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

            // Noise filter: skip onboarding/trial/marketing emails from
            // alert-sender domains. Still mark \Seen so they don't re-fire.
            if (!isAlertEmail(source, fromAddr, subject)) {
              await client.messageFlagsAdd(String(uid), ['\\Seen']);
              result.skipped++;
              logger.info(
                { from: maskEmail(fromAddr), subject: subject.slice(0, 80), source },
                'gmail-alert-poller: skipped noise (sender or subject pattern)'
              );
              continue;
            }

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

            // Prepend a [ProjectTag] to the Telegram title so Ahmad knows
            // which project the email came from. All Force projects share
            // one Gmail inbox + one Telegram chat, so without this every
            // alert reads as "untagged" — operator has to click into the
            // email body to find out. Tag is `null` when no marker matched;
            // we still send (with raw subject) so unknown alerts aren't lost.
            const projectTag = extractProject(subject, bodyExcerpt);
            const titledSubject = projectTag ? `[${projectTag}] ${subject}` : subject;

            await sendAlert({
              level: 'p1',
              scope: 'platform',
              source: `email.${source}`,
              title: titledSubject,
              body: bodyExcerpt,
              context: { from: fromAddr, uid: String(uid), project: projectTag ?? 'unknown' },
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
