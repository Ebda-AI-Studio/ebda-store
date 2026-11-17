import { assertStoreOperational } from '../lib/store-operational';
import { deliverableOnly } from '../lib/undeliverable-email';
import { withStore } from '@ebda/database';
import { resolveSender, type StoreSenderShape } from './email-sender';
import { EmailSendError, sendMail } from './mail-transport';

// Store-branded outbound mail (G6): resolves the sender (`<prefix>.<slug>@ebda.app`, see
// email-sender.ts) and hands the finished message to the Cloudflare Email Service transport
// (mail-transport.ts). Replaces the Resend service; per-store sender domains no longer exist.

export class StoreMailer {
  /**
   * Send a fully-rendered branded email on behalf of a store. Caller is
   * responsible for producing the HTML — this method just resolves the
   * sender and ships it through the Cloudflare mail transport.
   */
  static async sendBrandedEmail(
    storeId: string,
    opts: { to: string | string[]; subject: string; html: string; text?: string; replyTo?: string }
  ): Promise<{ id: string }> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: {
          id: true,
          name: true,
          slug: true,
          domain: true,
          email: true,
          emailSenderLocalPart: true,
          emailDomainStatus: true,
        },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);

    const sender = resolveSender(store);
    // A per-message reply-to (a shopper's contact message, FU46-1) outranks the store's default.
    const replyTo = opts.replyTo ?? sender.replyTo;
    return sendMail({
      from: sender.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      ...(opts.text ? { text: opts.text } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
  }

  /**
   * One marketing email to ONE address (email campaigns, D2). The caller has
   * already loaded the store, so this does no DB read per recipient.
   *
   * - `to` is a single string on purpose: a marketing send must never put two
   *   subscribers in one `to:` header (see `sendBrandedBatch`).
   * - `headers` carries only List-Unsubscribe / List-Unsubscribe-Post, built by
   *   `campaign.service#listUnsubscribeHeaders` from our own origin + token.
   * - `idempotencyKey` is accepted for callers but IGNORED: Cloudflare has no idempotency
   *   key, so a step that dies between send and its own "sent" mark can send twice
   *   (at-least-once; the recipient-status check closes most of that gap).
   */
  static async sendMarketingEmail(
    store: StoreSenderShape & { id: string },
    opts: {
      /** A test send to the merchant's OWN address: transactional to the merchant, so it is not refused for a suspended store. */
      toMerchant?: boolean;
      /** The caller already checked `storeOperational` for this whole batch (campaign-send): skip the per-message lookup. */
      operationalChecked?: boolean;
      to: string;
      subject: string;
      html: string;
      headers?: Record<string, string>;
      idempotencyKey?: string;
    }
  ): Promise<{ id: string }> {
    // Ruling SUSPEND-OUT-1: no marketing mail for a store that is not `active` (the one chokepoint of every campaign,
    // cart-recovery and test-to-subscriber send). The caller treats a thrown error as a failed send.
    if (!opts.toMerchant && !opts.operationalChecked) await assertStoreOperational(store.id);
    const sender = resolveSender(store);
    return sendMail({
      from: sender.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }

  /**
   * Branded emails to several addresses as SEPARATE messages — one address per
   * email, at most 100 per call, sent in order. Used by the legacy newsletter
   * broadcast, which previously passed a 50-address chunk as one `to:` array so
   * every subscriber received the other 49 addresses. Each message carries its
   * OWN html (per-subscriber unsubscribe link) and optional RFC 8058 headers.
   */
  static async sendBrandedBatch(
    storeId: string,
    opts: {
      subject: string;
      messages: Array<{
        to: string;
        html: string;
        text?: string;
        headers?: Record<string, string>;
      }>;
    }
  ): Promise<{ ids: string[]; error?: string }> {
    if (opts.messages.length === 0) return { ids: [] };
    if (opts.messages.length > 100) throw new Error('A branded batch accepts at most 100 emails');
    // Ruling SUSPEND-OUT-1: the newsletter broadcast is marketing to subscribers.
    await assertStoreOperational(storeId);
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: {
          id: true,
          name: true,
          slug: true,
          domain: true,
          email: true,
          emailSenderLocalPart: true,
          emailDomainStatus: true,
        },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);

    const sender = resolveSender(store);
    // One message per address, sent in order. A failure stops the batch; the addresses already
    // sent are reported (`ids`) so the caller never counts them as failed or re-sends them.
    const ids: string[] = [];
    for (const m of opts.messages) {
      // A reserved-TLD placeholder is dropped (and logged) before it counts as a send.
      if (deliverableOnly(m.to).length === 0) continue;
      try {
        const { id } = await sendMail({
          from: sender.from,
          to: m.to,
          subject: opts.subject,
          html: m.html,
          ...(m.text ? { text: m.text } : {}),
          ...(m.headers ? { headers: m.headers } : {}),
          ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
        });
        ids.push(id);
      } catch (err) {
        return { ids, error: err instanceof EmailSendError ? err.code : 'send_failed' };
      }
    }
    return { ids };
  }
}
