/**
 * Checkout email opt-in and the cart-restore link (review item 1).
 * Plan: docs/plans/done/2026-10-21-cart-email-campaigns.md; rulings CART-CONSENT-1, CART-RESTORE-1.
 *
 * `recordCartEmailConsent` is called when the shopper ticks (or unticks) "Email me about my cart"
 * at checkout. Ticking stores the address on the session cart with a consent timestamp AND upserts
 * the store's newsletter_subscribers row with source 'checkout' and the NARROW scope
 * 'cart_reminders' (no campaigns). The recovery email's consent gate (an active subscriber of the
 * store) is therefore unchanged, and guests are reachable.
 *
 * It never re-activates an unsubscribed address: anyone can type anyone's email into a checkout
 * form, so a deliberate "no" must not be undone by a stranger's checkbox.
 */
import { z } from 'zod/v3';
import { verifyCartRestoreToken } from '../lib/cart-restore-token';
import logger from '../lib/logger';
import { CartService } from './cart.service';
import { featureService } from './feature.service';
import { storeDb, storeWriter } from '../lib/repo-factory';

const emailSchema = z.string().trim().email().max(254);

export type CartEmailConsentStatus =
  | 'opted_in'
  | 'withdrawn'
  | 'unsubscribed'
  | 'no_cart'
  | 'invalid_email';

export async function recordCartEmailConsent(
  storeId: string,
  sessionId: string,
  input: { email: string; consent: boolean; language?: 'en' | 'ar' }
): Promise<{ status: CartEmailConsentStatus }> {
  const db = await storeDb(storeId);
  const w = await storeWriter(storeId);
  const cart = await db.cart.findFirst({ where: { storeId, sessionId }, select: { id: true } });
  if (!cart) return { status: 'no_cart' };

  if (!input.consent) {
    // Withdraw this cart's consent only; an existing subscription is the subscriber's to cancel
    // (one-click unsubscribe), not a checkbox's.
    await w.cart.updateMany({
      where: { id: cart.id, storeId },
      data: { guestEmail: null, guestEmailConsentAt: null },
    });
    return { status: 'withdrawn' };
  }

  const parsed = emailSchema.safeParse(input.email);
  if (!parsed.success) return { status: 'invalid_email' };
  const email = parsed.data.toLowerCase();

  const find = () =>
    db.newsletterSubscriber.findMany({
      where: { storeId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, isActive: true, unsubscribedAt: true },
    });
  let existing = await find();
  if (existing.some(s => !s.isActive || s.unsubscribedAt)) return { status: 'unsubscribed' };

  if (existing.length === 0) {
    const now = new Date();
    try {
      await w.newsletterSubscriber.create({
        data: {
          storeId,
          email,
          language: input.language ?? null,
          source: 'checkout',
          consentScope: 'cart_reminders',
          consentAt: now,
          isActive: true,
        },
      });
    } catch (err) {
      // A concurrent opt-in for the same address won the unique index: that is consent too.
      existing = await find();
      if (existing.length === 0 || existing.some(s => !s.isActive || s.unsubscribedAt)) throw err;
    }
  }

  await w.cart.updateMany({
    where: { id: cart.id, storeId },
    data: { guestEmail: email, guestEmailConsentAt: new Date() },
  });
  return { status: 'opted_in' };
}

/** Show the checkout box only when it can lead to an email: plan feature on AND channel on. */
export async function cartEmailOptInAvailable(storeId: string): Promise<boolean> {
  try {
    const cfg = await (
      await storeDb(storeId)
    ).abandonedCartConfig.findFirst({
      where: { storeId },
      select: { emailEnabled: true },
    });
    if (!cfg?.emailEnabled) return false;
    return await featureService.isFeatureEnabled(storeId, 'abandoned_cart');
  } catch (err) {
    logger.warn({ err, storeId }, '[CartEmail] opt-in availability check failed');
    return false;
  }
}

export type RestoreResult =
  | { restored: true; added: number }
  | { restored: false; reason: 'invalid' | 'gone' };

/**
 * Copy the source cart's lines into the VISITING session's cart (never the reverse, and the
 * source cart's session id is never revealed). Idempotent: a line the visitor's cart already has
 * (same product + variant, or same bundle) is left alone, so reopening the email twice does not
 * double quantities.
 */
export async function restoreCartIntoSession(
  storeId: string,
  token: unknown,
  sessionId: string,
  customerId?: string
): Promise<RestoreResult> {
  const ids = verifyCartRestoreToken(token);
  if (!ids || ids.storeId !== storeId) return { restored: false, reason: 'invalid' };

  const db = await storeDb(storeId);
  const source = await db.cart.findFirst({
    where: { id: ids.cartId, storeId },
    select: { id: true, sessionId: true },
  });
  if (!source) return { restored: false, reason: 'gone' };
  if (source.sessionId === sessionId) return { restored: true, added: 0 };

  const [items, bundles, mine] = await Promise.all([
    db.cartItem.findMany({
      where: { cartId: source.id },
      select: { productId: true, variantId: true, quantity: true, note: true },
    }),
    db.cartBundle.findMany({
      where: { cartId: source.id },
      select: { bundleId: true, quantity: true },
    }),
    db.cart.findFirst({ where: { storeId, sessionId }, select: { id: true } }),
  ]);
  const [myItems, myBundles] = mine
    ? await Promise.all([
        db.cartItem.findMany({
          where: { cartId: mine.id },
          select: { productId: true, variantId: true },
        }),
        db.cartBundle.findMany({ where: { cartId: mine.id }, select: { bundleId: true } }),
      ])
    : [[], []];

  const haveLine = new Set(myItems.map(i => `${i.productId}:${i.variantId ?? ''}`));
  const haveBundle = new Set(myBundles.map(b => b.bundleId));
  const missingItems = items.filter(i => !haveLine.has(`${i.productId}:${i.variantId ?? ''}`));
  const missingBundles = bundles.filter(b => !haveBundle.has(b.bundleId));

  let added = 0;
  if (missingItems.length > 0) {
    try {
      await CartService.addItems(
        storeId,
        sessionId,
        missingItems.map(i => ({
          productId: i.productId,
          variantId: i.variantId ?? undefined,
          quantity: i.quantity,
          note: i.note,
        })),
        customerId
      );
      added += missingItems.length;
    } catch (err) {
      logger.warn({ err, storeId }, '[CartRestore] adding lines failed');
    }
  }
  for (const b of missingBundles) {
    try {
      const r = await CartService.addBundle(storeId, sessionId, b.bundleId, b.quantity, customerId);
      if (r.ok) added++;
    } catch (err) {
      logger.warn({ err, storeId }, '[CartRestore] adding bundle failed');
    }
  }
  return { restored: true, added };
}
