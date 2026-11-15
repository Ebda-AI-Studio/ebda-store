import { storeDb } from '../lib/repo-factory';
import { buildBroadcastMessage } from '../lib/newsletter-broadcast';
import logger from '../lib/logger';
import { StoreMailer } from './store-mailer.service';
import { storeHidesPoweredBy } from './email.service';

/** Each recipient is one `send()` in this request; stays well under the 1,000-subrequest cap. */
export const BROADCAST_MAX_RECIPIENTS = 400;

/** Subscribers who may receive a newsletter broadcast: active, and never a 'cart_reminders'-only consent (checkout box). */
const audienceWhere = (storeId: string, language?: string) => ({
  storeId,
  isActive: true,
  consentScope: { not: 'cart_reminders' },
  ...(language ? { language } : {}),
});

/** How many subscribers a broadcast would reach now, capped at one past the send limit (never loads the list). */
export async function newsletterAudienceSize(storeId: string, language?: string): Promise<number> {
  const rows = await (
    await storeDb(storeId)
  ).newsletterSubscriber.findMany({
    where: audienceWhere(storeId, language),
    select: { id: true },
    take: BROADCAST_MAX_RECIPIENTS + 1,
  });
  return rows.length;
}

export type BroadcastResult =
  | { kind: 'store_not_found' }
  | { kind: 'too_large' }
  | { kind: 'empty' }
  | { kind: 'sent'; sent: number; total: number; errors: string[] };

/**
 * Sends a newsletter email to the active subscribers of the store, inside the store's branded email shell.
 * Every message carries its OWN per-subscriber one-click unsubscribe link + RFC 8058 headers (Ruling NEWSLETTER-UNSUB-1); the merchant HTML is
 * sanitized inside `renderCampaignEmail`. For very large lists use Campaigns (paced, per-recipient, resumable).
 */
export async function broadcastNewsletter(
  storeId: string,
  body: { subject: string; html: string; text?: string; language?: string }
): Promise<BroadcastResult> {
  // `defaultLanguage` lives inside the `settings` JSON column, not a first-class column, so we read `settings` and extract it manually.
  const store = await (
    await storeDb(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: {
      name: true,
      nameAr: true,
      logo: true,
      email: true,
      phone: true,
      address: true,
      settings: true,
      theme: true,
      emailSenderLocalPart: true,
      emailDomainStatus: true,
      domain: true,
      slug: true,
      id: true,
    },
  });
  if (!store) return { kind: 'store_not_found' };

  const subscribers = await (
    await storeDb(storeId)
  ).newsletterSubscriber.findMany({
    where: audienceWhere(storeId, body.language),
    select: { id: true, email: true, language: true },
    // one past the cap is enough to refuse (BE:E-5): never load the whole list
    take: BROADCAST_MAX_RECIPIENTS + 1,
  });
  // One provider call per subscriber inside this single request (Worker subrequest budget): big lists belong to Campaigns.
  if (subscribers.length > BROADCAST_MAX_RECIPIENTS) return { kind: 'too_large' };
  if (subscribers.length === 0) return { kind: 'empty' };

  const hidePoweredBy = await storeHidesPoweredBy(storeId);
  const messages = subscribers.map(sub =>
    buildBroadcastMessage({
      store,
      subscriber: sub,
      subject: body.subject,
      html: body.html,
      text: body.text,
      hidePoweredBy,
    })
  );

  // Chunks of 50: each is ONE Resend batch call carrying 50 SEPARATE emails, one address each (Ruling EC-6).
  const CHUNK = 50;
  let sent = 0;
  const errors: string[] = [];
  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    try {
      const r = await StoreMailer.sendBrandedBatch(storeId, {
        subject: chunk[0].subject,
        messages: chunk.map(({ to, html, text, headers }) => ({ to, html, text, headers })),
      });
      sent += r.ids.length;
      if (r.error) {
        logger.error({ storeId, code: r.error, chunk: i / CHUNK }, '[Newsletter] Chunk stopped');
        errors.push(`send stopped (${r.error}) after ${r.ids.length} of ${chunk.length}`);
        break; // later chunks would hit the same wall; the merchant sees the partial count
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'send failed';
      logger.error({ err, storeId, chunk: i / CHUNK }, '[Newsletter] Chunk send error');
      errors.push(msg);
    }
  }
  logger.info({ storeId, sent, errors: errors.length }, '[Newsletter] Broadcast complete');
  return { kind: 'sent', sent, total: messages.length, errors };
}
