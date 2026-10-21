/**
 * Abandoned-cart recovery EMAIL (cart-email-campaigns, 2026-10-21).
 * Plan: docs/plans/2026-10-21-cart-email-campaigns.md.
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
import { prisma, acrossStoresFlat, runInStoreScope, runInTenantContext } from '@ebda/database';
import { storefrontOrigin } from '@ebda/shared';
import { inngest } from '../lib/inngest/client';
import { awaitCampaignSendSlot } from '../lib/campaign-send-pacer';
import { signSubscriberUnsubscribeToken } from '../lib/campaign-unsubscribe-token';
import { storeBrandTheme } from '../lib/store-brand-theme';
import { config } from '../config';
import logger from '../lib/logger';
import { ResendService, ResendSendError } from './resend.service';
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
const ERROR_MAX = 300;

export const CART_RECOVERY_EMAIL_EVENT = 'cart-recovery/email-requested';

/** Delay is minutes of inactivity; the record already exists after 60 idle minutes. */
export function cartEmailDueAt(createdAt: Date, delayMinutes: number): Date {
  const extra = Math.max(0, delayMinutes - IDLE_BEFORE_RECORD_MINUTES);
  return new Date(createdAt.getTime() + extra * 60_000);
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

export async function sweepCartRecoveryEmails(
  now: Date = new Date()
): Promise<{ claimed: number; failed: number; stale: number }> {
  const result = { claimed: 0, failed: 0, stale: 0 };
  const windowStart = new Date(now.getTime() - SWEEP_WINDOW_MS);

  const candidates = await acrossStoresFlat(storeId =>
    prisma.abandonedCart.findMany({
      where: {
        storeId,
        emailStatus: null,
        customerEmail: { not: null },
        status: { not: 'recovered' },
        createdAt: { gte: windowStart },
      },
      select: { id: true, storeId: true, createdAt: true },
    })
  );
  if (candidates.length === 0) return result;

  const byStore = new Map<string, typeof candidates>();
  for (const c of candidates) byStore.set(c.storeId, [...(byStore.get(c.storeId) ?? []), c]);

  for (const [storeId, carts] of byStore) {
    await runInStoreScope(storeId, async () => {
      const cfg = await prisma.abandonedCartConfig.findUnique({
        where: { storeId },
        select: { emailEnabled: true, emailDelayMinutes: true },
      });
      if (!cfg?.emailEnabled) return;
      for (const c of carts) {
        const dueAt = cartEmailDueAt(c.createdAt, cfg.emailDelayMinutes);
        if (now.getTime() < dueAt.getTime()) continue;
        if (now.getTime() - dueAt.getTime() > STALE_AFTER_MS) {
          await prisma.abandonedCart.updateMany({
            where: { id: c.id, storeId, emailStatus: null },
            data: { emailStatus: 'skipped', emailDetail: 'stale' },
          });
          result.stale++;
          continue;
        }
        // The once-per-cart gate: only the sweep that flips NULL -> queued sends the event.
        const claim = await prisma.abandonedCart.updateMany({
          where: { id: c.id, storeId, emailStatus: null },
          data: { emailStatus: 'queued' },
        });
        if (claim.count !== 1) continue;
        try {
          await inngest.send({
            id: `cart-recovery-email/${c.id}`,
            name: CART_RECOVERY_EMAIL_EVENT,
            data: { abandonedCartId: c.id, storeId },
          });
          result.claimed++;
        } catch (err) {
          logger.error({ err, storeId, abandonedCartId: c.id }, '[CartEmail] enqueue failed');
          await prisma.abandonedCart.updateMany({
            where: { id: c.id, storeId, emailStatus: 'queued' },
            data: { emailStatus: 'failed', emailDetail: 'ENQUEUE_FAILED' },
          });
          result.failed++;
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
  await runInTenantContext(storeId, () =>
    prisma.abandonedCart.updateMany({
      where: { id, storeId, emailStatus: 'queued' },
      data,
    })
  );
}

export async function deliverCartRecoveryEmail(
  storeId: string,
  abandonedCartId: string
): Promise<DeliverOutcome> {
  const loaded = await runInTenantContext(storeId, async () => {
    const ac = await prisma.abandonedCart.findFirst({
      where: { id: abandonedCartId, storeId },
      select: {
        id: true,
        status: true,
        emailStatus: true,
        customerEmail: true,
        cartItems: true,
        cartTotal: true,
        recoveredAt: true,
      },
    });
    if (!ac) return null;
    const cfg = await prisma.abandonedCartConfig.findUnique({
      where: { storeId },
      select: { emailEnabled: true },
    });
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: CAMPAIGN_STORE_SELECT,
    });
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
  const subs = await runInTenantContext(storeId, () =>
    prisma.newsletterSubscriber.findMany({
      where: { storeId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, language: true, isActive: true, unsubscribedAt: true },
    })
  );
  if (subs.length === 0 || subs.some(s => !s.isActive || s.unsubscribedAt)) {
    return skip('no_consent');
  }
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
    cartUrl: `${base}/cart`,
    unsubscribeUrl: `${base}/unsubscribe?token=${encodeURIComponent(token)}`,
    hidePoweredBy: await storeHidesPoweredBy(storeId),
  });

  // Shared Resend budget (2 req/s, also carries transactional mail): wait for a slot, retry if none.
  if (!(await awaitCampaignSendSlot(30_000))) {
    throw new Error('no platform send slot free; retrying');
  }
  try {
    await ResendService.sendMarketingEmail(store, {
      to: email,
      subject,
      html,
      headers: listUnsubscribeHeaders(config.apiUrl, token),
      idempotencyKey: `cart-recovery-email/${ac.id}`,
    });
  } catch (err) {
    if (err instanceof ResendSendError && err.code === 'rate_limit_exceeded') throw err;
    const message = (err instanceof Error ? err.message : 'send failed').slice(0, ERROR_MAX);
    await finish(storeId, ac.id, { emailStatus: 'failed', emailDetail: message });
    logger.warn(
      {
        storeId,
        abandonedCartId: ac.id,
        code: err instanceof ResendSendError ? err.code : 'unknown',
      },
      '[CartEmail] send failed'
    );
    return { outcome: 'failed', detail: message };
  }
  // Outside the try: if this write fails the step retries and Resend's idempotency key dedupes.
  await finish(storeId, ac.id, { emailStatus: 'sent', emailDetail: null, emailSentAt: new Date() });
  return { outcome: 'sent' };
}
