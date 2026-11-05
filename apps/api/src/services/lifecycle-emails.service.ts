/**
 * Self-serve lifecycle emails: setup nudges, trial recap, first-order referral ask (growth strategy
 * section 3.4). Each is triggered by REAL store state, never by the calendar alone: the Inngest function
 * wakes at the due time and `processLifecycleEmail` re-reads the state and exits (recording WHY) when the
 * step is already done.
 *
 * Idempotency: a row in `store_lifecycle_emails` (UNIQUE store + kind) is inserted BEFORE anything is
 * sent. Only the caller that wins the insert sends, so an Inngest retry, a duplicate event or a second
 * run never sends the same email twice. The row is the merchant-visible log (page
 * /stores/[id]/lifecycle-emails); an enqueue failure flips it to `failed` with a reason, never leaves it
 * looking sent.
 *
 * Consent: a merchant who clicked the unsubscribe link has an `optout` row; while it exists nothing is
 * sent (each kind is recorded `skipped: opted_out`). Only the store owner is ever mailed, never a shopper.
 *
 * Must run with the store's tenant context available: every read/write goes through `withStore`.
 */
import { isDemoStore } from '../lib/demo-store';
import { prisma, withStore } from '@ebda/database';
import { storeDb } from '../lib/repo-factory';
import { customersById, runInStoreCtx } from '../lib/jobs/store-db';
import {
  LIFECYCLE_EMAIL_KINDS,
  LIFECYCLE_OPTOUT_KIND,
  REFERRAL_UTM,
  referralUrl,
  storeOrigin,
  type LifecycleEmailKind,
  type LifecycleStatus,
} from '@ebda/shared';
import { config } from '../config';
import logger from '../lib/logger';
import { EmailService } from './email.service';
import { SetupGuideService } from './setup-guide.service';
import { lifecycleUnsubscribeUrl } from '../lib/lifecycle-unsubscribe-token';

export type LifecycleResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'duplicate' }
  /** Nothing recorded (the trigger does not apply to this store/order); the next trigger may retry. */
  | { status: 'ignored'; reason: string };

/** Facts the skip rules read. Plain data so the rules are unit-testable without a database. */
export interface LifecycleFacts {
  productAdded: boolean;
  paymentDone: boolean;
  shippingDone: boolean;
  hasOrder: boolean;
  trialing: boolean;
}

/** Why a kind must NOT be sent given the facts, or null when it should go out. */
export function skipReason(kind: LifecycleEmailKind, f: LifecycleFacts): string | null {
  switch (kind) {
    case 'add_products':
      return f.productAdded ? 'products_added' : null;
    case 'payment_shipping':
      return f.paymentDone && f.shippingDone ? 'payment_and_shipping_done' : null;
    case 'test_order':
      return f.hasOrder ? 'order_placed' : null;
    case 'share_link':
      return null;
    case 'trial_recap':
      return f.trialing ? null : 'not_trialing';
    case 'first_order':
      return f.hasOrder ? null : 'no_order';
  }
}

async function record(
  storeId: string,
  kind: string,
  status: LifecycleStatus,
  reason: string | null
): Promise<boolean> {
  const { count } = await withStore(storeId, tx =>
    tx.storeLifecycleEmail.createMany({
      data: [{ storeId, kind, status, reason }],
      skipDuplicates: true,
    })
  );
  return count === 1;
}

export async function isOptedOut(storeId: string): Promise<boolean> {
  const row = await withStore(storeId, tx =>
    tx.storeLifecycleEmail.findUnique({
      where: { storeId_kind: { storeId, kind: LIFECYCLE_OPTOUT_KIND } },
      select: { id: true },
    })
  );
  return !!row;
}

/** Record the merchant's unsubscribe. Idempotent. */
export async function optOut(storeId: string): Promise<void> {
  await record(storeId, LIFECYCLE_OPTOUT_KIND, 'sent', 'unsubscribed_by_link');
}

export interface LifecycleEnrollment {
  createdAt: string;
  trialEndsAt: string | null;
}

/** A self-serve store is one that started a signup trial; null = unknown store or not enrolled. */
export async function getEnrollment(storeId: string): Promise<LifecycleEnrollment | null> {
  return withStore(storeId, async tx => {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { createdAt: true },
    });
    if (!store) return null;
    const sub = await tx.storeSubscription.findUnique({
      where: { storeId },
      select: { trialEndsAt: true },
    });
    if (!sub?.trialEndsAt) return null;
    return {
      createdAt: store.createdAt.toISOString(),
      trialEndsAt: sub.trialEndsAt.toISOString(),
    };
  });
}

export async function processLifecycleEmail(
  storeId: string,
  kind: LifecycleEmailKind,
  opts: { orderId?: string; now?: Date } = {}
): Promise<LifecycleResult> {
  const ctx = await withStore(storeId, async tx => {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        slug: true,
        domain: true,
        status: true,
        settings: true,
        owner: { select: { email: true, status: true } },
      },
    });
    if (!store) return null;
    const sub = await tx.storeSubscription.findUnique({
      where: { storeId },
      select: { status: true, trialEndsAt: true },
    });
    return { store, sub };
  });
  if (!ctx) return { status: 'ignored', reason: 'store_missing' };
  const { store, sub } = ctx;
  // Not a self-serve store (super-admin provisioned, "done for you"): these emails are not for it.
  if (!sub?.trialEndsAt) return { status: 'ignored', reason: 'not_self_serve' };
  // A showroom has no merchant to nudge (its owner address is the operator's own).
  if (await isDemoStore(storeId)) return { status: 'ignored', reason: 'demo_store' };

  const record_ = (status: LifecycleStatus, reason: string | null) =>
    record(storeId, kind, status, reason);
  const skip = async (reason: string): Promise<LifecycleResult> =>
    (await record_('skipped', reason)) ? { status: 'skipped', reason } : { status: 'duplicate' };

  if (await isOptedOut(storeId)) return skip('opted_out');
  if (store.status !== 'active' || store.owner?.status !== 'active')
    return skip('store_not_active');
  if (!store.owner?.email) return skip('no_recipient');

  // Real state, read through the same service the dashboard checklist uses.
  const guide = await runInStoreCtx(storeId, () => SetupGuideService.get(storeId));
  const done = (key: string) => guide.items.find(i => i.key === key)?.done === true;
  const facts: LifecycleFacts = {
    productAdded: done('add_product'),
    paymentDone: done('payment'),
    shippingDone: done('shipping'),
    hasOrder: done('test_order'),
    trialing: sub.status === 'trialing',
  };

  if (kind === 'first_order') {
    // The owner placing a test order from their own storefront is not "the first order".
    if (!opts.orderId) return { status: 'ignored', reason: 'no_order_id' };
    const found = await (
      await storeDb(storeId)
    ).order.findUnique({
      where: { id: opts.orderId, storeId },
      select: { status: true, shippingAddress: true, customerId: true },
    });
    // the buyer is a platform `User`, attached after the read (Ruling CF-JOBS-4)
    const order = found
      ? {
          ...found,
          customer: (await customersById(storeId, [found.customerId])).get(found.customerId ?? ''),
        }
      : null;
    if (!order || order.status === 'cancelled')
      return { status: 'ignored', reason: 'order_unusable' };
    const shipEmail = (order.shippingAddress as { email?: unknown } | null)?.email;
    const buyer = (
      order.customer?.email || (typeof shipEmail === 'string' ? shipEmail : '')
    ).toLowerCase();
    if (buyer && buyer === store.owner.email.toLowerCase()) {
      return { status: 'ignored', reason: 'owner_test_order' };
    }
    facts.hasOrder = true;
  }

  const why = skipReason(kind, facts);
  if (why) return skip(why);

  // Win the row first; only the winner sends.
  if (!(await record_('sent', null))) return { status: 'duplicate' };

  const lang: 'ar' | 'en' =
    (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en' ? 'en' : 'ar';
  const admin = `${(config.adminUrl ?? '').replace(/\/$/, '')}/stores/${storeId}`;
  const storefront = store.domain ? `https://${store.domain}` : storeOrigin(store.slug);
  let recoveredCarts: number | undefined;
  if (kind === 'trial_recap') {
    recoveredCarts = await (
      await storeDb(storeId)
    ).abandonedCart.count({ where: { storeId, recoveredAt: { not: null } } });
  }
  const now = opts.now ?? new Date();
  try {
    await EmailService.sendLifecycleEmail(
      {
        kind,
        to: store.owner.email,
        storeName: store.name,
        links: {
          products: `${admin}/products`,
          payment: `${admin}/payment-settings`,
          storefront,
          billing: `${admin}/billing`,
        },
        unsubscribeUrl: lifecycleUnsubscribeUrl(storeId),
        recoveredCarts,
        daysLeft: sub.trialEndsAt
          ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000))
          : undefined,
        referralUrl: kind === 'first_order' ? referralUrl('email', store.slug) : undefined,
      },
      lang
    );
  } catch (err) {
    logger.warn({ err, storeId, kind }, '[lifecycle-email] enqueue failed');
    await withStore(storeId, tx =>
      tx.storeLifecycleEmail.updateMany({
        where: { storeId, kind },
        data: { status: 'failed', reason: 'ENQUEUE_FAILED' },
      })
    );
    return { status: 'failed', reason: 'ENQUEUE_FAILED' };
  }
  return { status: 'sent' };
}

export interface LifecycleLogEntry {
  kind: LifecycleEmailKind;
  status: LifecycleStatus | 'pending';
  reason: string | null;
  at: string | null;
}

/** The merchant's view: every kind, in send order, with what happened (or `pending`). */
export async function listLifecycleLog(storeId: string): Promise<{
  optedOut: boolean;
  entries: LifecycleLogEntry[];
}> {
  const rows = await withStore(storeId, tx =>
    tx.storeLifecycleEmail.findMany({
      where: { storeId },
      select: { kind: true, status: true, reason: true, createdAt: true },
    })
  );
  const byKind = new Map(rows.map(r => [r.kind, r]));
  return {
    optedOut: byKind.has(LIFECYCLE_OPTOUT_KIND),
    entries: LIFECYCLE_EMAIL_KINDS.map(kind => {
      const r = byKind.get(kind);
      return {
        kind,
        status: (r?.status as LifecycleStatus | undefined) ?? 'pending',
        reason: r?.reason ?? null,
        at: r ? r.createdAt.toISOString() : null,
      };
    }),
  };
}

/**
 * Super-admin count of merchant signups that arrived through a referral surface: the "made with Ebda"
 * store badge and the first-order referral email. Read from the first-touch UTM captured at signup
 * (`users.acquisition`, kept only for visitors who consented), so it is a floor, not an exact figure.
 * Cross-tenant read: the caller wraps it in `asPlatformOperator`.
 */
export async function referralSignupCounts(): Promise<{ badge: number; email: number }> {
  const count = (source: string) =>
    prisma.user.count({
      where: {
        storeId: null,
        acquisition: { path: ['attribution', 'utm_source'], equals: source },
      },
    });
  const [badge, email] = await Promise.all([
    count(REFERRAL_UTM.badge.source),
    count(REFERRAL_UTM.email.source),
  ]);
  return { badge, email };
}
