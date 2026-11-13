/**
 * Abandoned-cart recovery EMAIL (cart-email-campaigns, 2026-10-21).
 * Plan: docs/plans/done/2026-10-21-cart-email-campaigns.md.
 *
 * A third recovery channel next to push/SMS, independent of their `status`
 * sequence. ONE reminder per cart, ever:
 *   sweep   (cron, every 15 min, from abandonedCartService.process): claims due
 *           carts NULL -> 'queued' with a single conditional UPDATE and emits
 *           `cart-recovery/email-requested` (event id = the cart). Enqueue
 *           failure marks the row 'failed' (never an orphan 'queued').
 *   deliver (Inngest `cart-recovery-email`): re-checks everything at send time
 *           and sends through the STORE's sender (never an Ebda inbox).
 *
 * Consent (Ruling EC-1, same model as email campaigns): the only email
 * marketing opt-in in the schema is the store's newsletter subscription. A cart
 * email goes only to an ACTIVE subscriber of the SAME store; if any casing
 * variant of the address has unsubscribed, nothing is sent. Every email carries
 * the per-subscriber one-click unsubscribe (RFC 8058 headers + footer link).
 */
import { acrossStoresFlat, runInStoreScope, runInTenantContext, withStore } from '@ebda/database';
import { storeRepo, type StoreReads, type StoreWrites } from '../lib/repo-factory';
import { storefrontOrigin } from '@ebda/shared';
import { inngest } from '../lib/inngest/client';
import { CI_CART_REMINDER_EVENT } from '../lib/ci/events';
import { awaitCampaignSendSlot } from '../lib/campaign-send-pacer';
import { signCartRestoreToken } from '../lib/cart-restore-token';
import { signSubscriberUnsubscribeToken } from '../lib/campaign-unsubscribe-token';
import { storeBrandTheme } from '../lib/store-brand-theme';
import { config } from '../config';
import logger from '../lib/logger';
import { StoreMailer } from './store-mailer.service';
import { EmailSendError } from './mail-transport';
import { featureService } from './feature.service';
import { renderBrandedShell, storeHidesPoweredBy } from './email.service';
import {
  CAMPAIGN_STORE_SELECT,
  listUnsubscribeHeaders,
  normalizeEmail,
  sanitizeSubject,
  storeDefaultLanguage,
  type CampaignStoreContext,
} from './campaign.service';
import { cartRecoveryTemplate, type CartRecoveryItem } from './email-templates/cart-recovery';

export const CART_EMAIL_DEFAULT_DELAY_MINUTES = 120;
export const CART_EMAIL_MIN_DELAY_MINUTES = 60;
export const CART_EMAIL_MAX_DELAY_MINUTES = 1440;

/** A cart is recorded as abandoned after this much inactivity (abandoned-cart.service). */
const IDLE_BEFORE_RECORD_MINUTES = 60;
/** A reminder this long past its due time is not sent (the merchant enabled the channel late). */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Carts recorded before this window are no longer swept at all. */
const SWEEP_WINDOW_MS = (CART_EMAIL_MAX_DELAY_MINUTES + 60) * 60 * 1000 + STALE_AFTER_MS;
/** A claimed row older than this with no outcome is re-emitted by the sweep. */
const STUCK_QUEUED_MS = 30 * 60 * 1000;
const ERROR_MAX = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cart reminders one store may send in any rolling 24 h (its own cap, on top of sharing the
 * campaign budget via `sentInLast24h`). Bounded by cart volume anyway; this is the fuse.
 */
export function cartEmailDailyCap(): number {
  const n = parseInt(process.env.CART_EMAIL_DAILY_CAP ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

// Send errors that are the REQUEST's fault (`EmailSendError.permanent`: bad payload, suppressed
// recipient): retrying cannot help, so the cart is marked failed. Everything else (provider 5xx,
// rate limits, unknown codes, network errors) is transient and is rethrown so the job retries it;
// `onFailure` marks the cart failed once the retries are exhausted.

/**
 * One store's reads and writes for a job step (Ruling CF-R4-5). A store on Postgres keeps its request-style tenant scope
 * (`runInTenantContext`, unchanged); a store on its Durable Object has no Postgres scope to open, its rows come over RPC.
 */
async function inStore<T>(
  storeId: string,
  fn: (db: StoreReads, w: StoreWrites) => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  const run = () => fn(repo.db, repo.writer);
  return repo.backend === 'do' ? run() : runInTenantContext(storeId, run);
}

export const CART_RECOVERY_EMAIL_EVENT = 'cart-recovery/email-requested';

/** Delay is minutes of inactivity; the record already exists after 60 idle minutes. */
export function cartEmailDueAt(createdAt: Date, delayMinutes: number): Date {
  const extra = Math.max(0, delayMinutes - IDLE_BEFORE_RECORD_MINUTES);
  return new Date(createdAt.getTime() + extra * 60_000);
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

export async function sweepCartRecoveryEmails(
  now: Date = new Date()
): Promise<{ claimed: number; failed: number; stale: number; requeued: number }> {
  const result = { claimed: 0, failed: 0, stale: 0, requeued: 0 };
  const windowStart = new Date(now.getTime() - SWEEP_WINDOW_MS);

  // Only stores with the channel ON are scanned at all (one config read per store, then the
  // cart queries only for the enabled ones).
  const enabled = await acrossStoresFlat(async storeId =>
    (await storeRepo(storeId)).db.abandonedCartConfig.findMany({
      where: { storeId, emailEnabled: true },
      select: { storeId: true, emailDelayMinutes: true },
    })
  );
  if (enabled.length === 0) return result;

  const emit = (id: string, storeId: string) =>
    inngest.send({
      id: `cart-recovery-email/${id}`,
      name: CART_RECOVERY_EMAIL_EVENT,
      data: { abandonedCartId: id, storeId },
    });

  for (const cfg of enabled) {
    const { storeId } = cfg;
    const { db, writer } = await storeRepo(storeId).then(r => ({ db: r.db, writer: r.writer }));
    await runInStoreScope(storeId, async () => {
      const carts = await db.abandonedCart.findMany({
        where: {
          storeId,
          emailStatus: null,
          customerEmail: { not: null },
          status: { not: 'recovered' },
          createdAt: { gte: windowStart },
        },
        select: { id: true, createdAt: true },
      });
      for (const c of carts) {
        const dueAt = cartEmailDueAt(c.createdAt, cfg.emailDelayMinutes);
        if (now.getTime() < dueAt.getTime()) continue;
        if (now.getTime() - dueAt.getTime() > STALE_AFTER_MS) {
          await writer.abandonedCart.updateMany({
            where: { id: c.id, storeId, emailStatus: null },
            data: { emailStatus: 'skipped', emailDetail: 'stale' },
          });
          result.stale++;
          continue;
        }
        // The once-per-cart gate: only the sweep that flips NULL -> queued sends the event.
        const claim = await writer.abandonedCart.updateMany({
          where: { id: c.id, storeId, emailStatus: null },
          data: { emailStatus: 'queued' },
        });
        if (claim.count !== 1) continue;
        try {
          await emit(c.id, storeId);
          result.claimed++;
        } catch (err) {
          logger.error({ err, storeId, abandonedCartId: c.id }, '[CartEmail] enqueue failed');
          await writer.abandonedCart.updateMany({
            where: { id: c.id, storeId, emailStatus: 'queued' },
            data: { emailStatus: 'failed', emailDetail: 'ENQUEUE_FAILED' },
          });
          result.failed++;
        }
      }

      // A row claimed but never finished (the process died between the claim and the send, or the
      // event was lost) is re-emitted with the SAME event id: a live duplicate dedupes in Inngest,
      // a lost one runs. The job and the Resend key are idempotent either way.
      const stuck = await db.abandonedCart.findMany({
        where: {
          storeId,
          emailStatus: 'queued',
          updatedAt: { lt: new Date(now.getTime() - STUCK_QUEUED_MS) },
          createdAt: { gte: windowStart },
        },
        select: { id: true },
      });
      for (const c of stuck) {
        try {
          await emit(c.id, storeId);
          result.requeued++;
        } catch (err) {
          logger.error({ err, storeId, abandonedCartId: c.id }, '[CartEmail] requeue failed');
        }
      }
    });
  }
  return result;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function parseItems(raw: unknown): CartRecoveryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CartRecoveryItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.productName !== 'string' || !o.productName) continue;
    out.push({
      productName: o.productName,
      price: Number.isFinite(o.price) ? Number(o.price) : 0,
      quantity: Number.isFinite(o.quantity) && Number(o.quantity) > 0 ? Number(o.quantity) : 1,
    });
  }
  return out;
}

export function renderCartRecoveryEmail(args: {
  store: CampaignStoreContext;
  locale: 'en' | 'ar';
  items: unknown;
  total: number;
  cartUrl: string;
  unsubscribeUrl: string;
  consentScope?: 'newsletter' | 'cart_reminders';
  hidePoweredBy?: boolean;
}): { subject: string; html: string } {
  const { store, locale } = args;
  const storeName = locale === 'ar' && store.nameAr ? store.nameAr : store.name;
  const data = {
    storeName,
    items: parseItems(args.items),
    total: args.total,
    cartUrl: args.cartUrl,
    unsubscribeUrl: args.unsubscribeUrl,
    consentScope: args.consentScope ?? 'newsletter',
  };
  const html = renderBrandedShell(cartRecoveryTemplate[locale](data), {
    name: store.name,
    nameAr: store.nameAr,
    logo: store.logo,
    email: store.email,
    phone: store.phone,
    address: store.address,
    theme: storeBrandTheme(store) as {
      primaryColor?: string | null;
      primary?: string | null;
    } | null,
    defaultLanguage: locale,
    hidePoweredBy: args.hidePoweredBy,
  });
  return { subject: sanitizeSubject(cartRecoveryTemplate.subject[locale](data)), html };
}

// ─── Deliver ─────────────────────────────────────────────────────────────────

export interface DeliverOutcome {
  outcome: 'sent' | 'skipped' | 'failed' | 'noop';
  detail?: string;
}

async function finish(
  storeId: string,
  id: string,
  data: { emailStatus: string; emailDetail?: string | null; emailSentAt?: Date }
) {
  await inStore(storeId, (_db, w) =>
    w.abandonedCart.updateMany({
      where: { id, storeId, emailStatus: 'queued' },
      data,
    })
  );
}

export async function deliverCartRecoveryEmail(
  storeId: string,
  abandonedCartId: string
): Promise<DeliverOutcome> {
  const loaded = await inStore(storeId, async db => {
    const ac = await db.abandonedCart.findFirst({
      where: { id: abandonedCartId, storeId },
      select: {
        id: true,
        cartId: true,
        status: true,
        emailStatus: true,
        customerEmail: true,
        cartItems: true,
        cartTotal: true,
        recoveredAt: true,
      },
    });
    if (!ac) return null;
    const cfg = await db.abandonedCartConfig.findUnique({
      where: { storeId },
      select: { emailEnabled: true },
    });
    // `Store` is a platform table: a context-independent read, whichever backend serves the store's rows
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: CAMPAIGN_STORE_SELECT })
    );
    return { ac, cfg, store: store as CampaignStoreContext | null };
  });

  // Idempotency: only a claimed ('queued') row is ever mailed, and only once.
  if (!loaded || loaded.ac.emailStatus !== 'queued') return { outcome: 'noop' };
  const { ac, cfg, store } = loaded;

  const skip = async (detail: string): Promise<DeliverOutcome> => {
    await finish(storeId, ac.id, { emailStatus: 'skipped', emailDetail: detail });
    logger.info({ storeId, abandonedCartId: ac.id, detail }, '[CartEmail] skipped');
    return { outcome: 'skipped', detail };
  };

  if (!store) return skip('store_missing');
  if (!cfg?.emailEnabled) return skip('disabled');
  if (ac.status === 'recovered' || ac.recoveredAt) return skip('recovered');
  if (!ac.customerEmail || !ac.customerEmail.includes('@')) return skip('no_email');
  if (!(await featureService.isFeatureEnabled(storeId, 'abandoned_cart'))) {
    return skip('feature_off');
  }

  // Consent: active newsletter subscriber of THIS store; any unsubscribed casing variant blocks.
  const email = normalizeEmail(ac.customerEmail);
  const subs = await inStore(storeId, db =>
    db.newsletterSubscriber.findMany({
      where: { storeId, email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        language: true,
        isActive: true,
        unsubscribedAt: true,
        consentScope: true,
      },
    })
  );
  if (subs.length === 0 || subs.some(s => !s.isActive || s.unsubscribedAt)) {
    return skip('no_consent');
  }
  // The store's own fuse: past it the reminder is skipped, not queued for tomorrow (stale mail).
  const sentToday = await inStore(storeId, db =>
    db.abandonedCart.count({
      where: { storeId, emailSentAt: { gte: new Date(Date.now() - DAY_MS) } },
    })
  );
  if (sentToday >= cartEmailDailyCap()) return skip('daily_cap');
  const subscriber = subs[0];
  const locale: 'en' | 'ar' =
    subscriber.language === 'ar'
      ? 'ar'
      : subscriber.language === 'en'
        ? 'en'
        : storeDefaultLanguage(store);

  const base = storefrontOrigin(store);
  const token = signSubscriberUnsubscribeToken(storeId, subscriber.id);
  const { subject, html } = renderCartRecoveryEmail({
    store,
    locale,
    items: ac.cartItems,
    total: ac.cartTotal,
    // Signed, expiring, store-scoped: re-attaches THIS cart for guests too (Ruling CART-RESTORE-1).
    cartUrl: `${base}/cart?restore=${encodeURIComponent(signCartRestoreToken(storeId, ac.cartId))}`,
    consentScope: subscriber.consentScope === 'cart_reminders' ? 'cart_reminders' : 'newsletter',
    unsubscribeUrl: `${base}/unsubscribe?token=${encodeURIComponent(token)}`,
    hidePoweredBy: await storeHidesPoweredBy(storeId),
  });

  // Shared Resend budget (2 req/s, also carries transactional mail): wait for a slot, retry if none.
  if (!(await awaitCampaignSendSlot(30_000))) {
    throw new Error('no platform send slot free; retrying');
  }
  // Stop-on-convert (Ruling CART-EMAIL-3): the slot wait above can take up to 30 s, so re-read the
  // cart's state in the last moment before Resend. An order placed meanwhile, or a cart the
  // shopper emptied, must not get the reminder.
  const fresh = await inStore(storeId, async db => {
    const [row, items, bundles] = await Promise.all([
      db.abandonedCart.findFirst({
        where: { id: ac.id, storeId },
        select: { status: true, recoveredAt: true, emailStatus: true },
      }),
      db.cartItem.count({ where: { cartId: ac.cartId } }),
      db.cartBundle.count({ where: { cartId: ac.cartId } }),
    ]);
    return { row, hasItems: items + bundles > 0 };
  });
  if (!fresh.row || fresh.row.emailStatus !== 'queued') return { outcome: 'noop' };
  if (fresh.row.status === 'recovered' || fresh.row.recoveredAt) return skip('recovered');
  if (!fresh.hasItems) return skip('cart_empty');
  try {
    await StoreMailer.sendMarketingEmail(store, {
      to: email,
      subject,
      html,
      headers: listUnsubscribeHeaders(config.apiUrl, token),
      idempotencyKey: `cart-recovery-email/${ac.id}`,
    });
  } catch (err) {
    if (!(err instanceof EmailSendError && err.permanent)) throw err;
    const message = (err instanceof Error ? err.message : 'send failed').slice(0, ERROR_MAX);
    await finish(storeId, ac.id, { emailStatus: 'failed', emailDetail: message });
    logger.warn(
      {
        storeId,
        abandonedCartId: ac.id,
        code: err instanceof EmailSendError ? err.code : 'unknown',
      },
      '[CartEmail] send failed'
    );
    return { outcome: 'failed', detail: message };
  }
  // Outside the try: if this write fails the step retries and Resend's idempotency key dedupes.
  await finish(storeId, ac.id, { emailStatus: 'sent', emailDetail: null, emailSentAt: new Date() });
  // CI-13: the recovery email went out. A failed enqueue is logged and never undoes the send.
  await inngest
    .send({
      name: CI_CART_REMINDER_EVENT,
      data: {
        storeId,
        abandonedCartId: ac.id,
        channel: 'email',
        step: 1,
        at: new Date().toISOString(),
      },
    })
    .catch(err => logger.warn({ err, abandonedCartId: ac.id }, '[CartEmail] ci event not sent'));
  return { outcome: 'sent' };
}
