/**
 * WhatsApp MARKETING consent (Ruling WA-CONSENT-1). Cart reminders are marketing (Meta classifies them
 * as marketing templates; PDPL needs prior consent for electronic marketing), so `cart.abandoned` is
 * emitted ONLY for a buyer with an active consent. Order, COD and shipping messages are transactional
 * and never read this. Consent is unticked by default, recorded with time, source and the label
 * language, revocable (the buyer, the merchant, or a STOP on WhatsApp), exported with the account and
 * erased with it. It is keyed by the suite buyer key, so it holds no raw phone.
 */
import { prisma, runInTenantContext } from '@ebda/database';
import { buyerKeyFor, toE164 } from '@ebda/shared';
import { suiteBuyerKeySecret } from './config';

export type ConsentSource = 'checkout' | 'cart' | 'admin' | 'whatsapp';

export interface ConsentInput {
  consent: boolean;
  /** The account making the write (absent for a STOP or an admin action on a bare number). Never binds. */
  userId?: string;
  /** Set ONLY on a PROVEN grant: the account becomes the row's owner (export/erasure scope). */
  bindUserId?: string;
  source: ConsentSource;
  locale?: 'en' | 'ar';
}

/**
 * Is `phone` the contact number on a DELIVERED order this customer placed? A pending or cancelled order
 * proves nothing (the number is typed free text); a delivered one means the courier reached it.
 */
export async function phoneOnOwnOrder(
  storeId: string,
  userId: string,
  phone: string,
  // The caller's transaction client when it is inside a tenant scope (erasure); the ambient client otherwise.
  client: Pick<typeof prisma, 'order'> = prisma
): Promise<boolean> {
  const want = toE164(phone);
  if (!want) return false;
  const orders = await client.order.findMany({
    where: { storeId, customerId: userId, status: 'delivered' },
    select: { shippingAddress: true },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  return orders.some(o => {
    const p = (o.shippingAddress as { phone?: unknown } | null)?.phone;
    return typeof p === 'string' && toE164(p) === want;
  });
}

/** The customer changed their profile phone: the OLD number's consent ends; the new one needs a fresh tick. */
export async function revokeForPhoneChange(storeId: string, oldPhone: string): Promise<void> {
  const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), oldPhone);
  if (!buyerKey) return;
  await runInTenantContext(storeId, () =>
    prisma.storeWhatsAppConsent.updateMany({
      where: { storeId, buyerKey, granted: true },
      data: { granted: false, revokedAt: new Date(), revokedSource: 'profile' },
    })
  );
}

export const WhatsAppConsentService = {
  /** Record or withdraw the consent for the buyer behind `phone`. Null when the phone is not a phone. */
  async record(
    storeId: string,
    phone: string,
    input: ConsentInput
  ): Promise<{ granted: boolean } | null> {
    const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), phone);
    if (!buyerKey) return null;
    return this.recordForKey(storeId, buyerKey, input);
  },

  async recordForKey(
    storeId: string,
    buyerKey: string,
    input: ConsentInput
  ): Promise<{ granted: boolean }> {
    const now = new Date();
    // ONE writer per outcome; every write is seen by the database observer (consent-state.ts), which
    // tells Ebda WhatsApp (customer.consent_changed), so no path can change consent unannounced.
    await runInTenantContext(storeId, async () => {
      // Ownership (`userId`) is set ONLY by a PROVEN grant (`bindUserId`). A revoke, a STOP or an admin
      // write NEVER sets, clears or overwrites it (an unproven account must not be able to strip
      // another account's ownership and so make its erasure miss the row); only a proven grant by
      // another account rebinds the row. `undefined` = leave the column as it is.
      const owner: string | undefined = input.bindUserId;
      await prisma.storeWhatsAppConsent.upsert({
        where: { storeId_buyerKey: { storeId, buyerKey } },
        create: {
          storeId,
          buyerKey,
          userId: input.bindUserId ?? null,
          ...(input.consent
            ? {
                granted: true,
                grantedAt: now,
                grantedSource: input.source,
                locale: input.locale ?? null,
              }
            : { granted: false, revokedAt: now, revokedSource: input.source }),
        },
        update: {
          ...(owner !== undefined ? { userId: owner } : {}),
          ...(input.consent
            ? {
                granted: true,
                grantedAt: now,
                grantedSource: input.source,
                locale: input.locale ?? null,
                revokedAt: null,
                revokedSource: null,
              }
            : { granted: false, revokedAt: now, revokedSource: input.source }),
        },
      });
    });
    return { granted: input.consent };
  },

  /**
   * The checkout box (Ruling WA-CONSENT-1, security review): the phone is NEVER taken from the request.
   * The caller is an authenticated customer, the cart must be THEIR session cart, and the number is the
   * one on THEIR account (the same number the cart reminder is sent to). A different session, a
   * guest, or a body-supplied phone can neither opt in nor revoke anybody.
   */
  async recordForCart(
    storeId: string,
    sessionId: string,
    userId: string,
    input: { consent: boolean; locale?: 'en' | 'ar' }
  ): Promise<
    | { status: 'recorded'; granted: boolean; cartId: string }
    | { status: 'no_cart' | 'no_phone' | 'phone_unproven' }
  > {
    const cart = await prisma.cart.findFirst({
      where: { storeId, sessionId, customerId: userId },
      select: { id: true },
    });
    // GRANTING is tied to this session's cart; WITHDRAWING needs no cart (any device, any time).
    if (!cart && input.consent) return { status: 'no_cart' };
    const user = await prisma.user.findFirst({
      where: { id: userId, storeId },
      select: { phone: true },
    });
    if (!user?.phone) return { status: 'no_phone' };
    // A profile phone is self-declared, so GRANTING needs proof the number is theirs: it must be the
    // number on an order THIS customer placed. Withdrawing needs no proof (revocation always works).
    if (input.consent && !(await phoneOnOwnOrder(storeId, userId, user.phone))) {
      return { status: 'phone_unproven' };
    }
    const r = await this.record(storeId, user.phone, {
      consent: input.consent,
      source: 'checkout',
      locale: input.locale,
      userId,
      ...(input.consent ? { bindUserId: userId } : {}),
    });
    if (!r) return { status: 'no_phone' };
    return { status: 'recorded', granted: r.granted, cartId: cart?.id ?? 'none' };
  },

  /** The signed-in customer's current consent for their account number (so the box shows the truth). */
  async stateForUser(
    storeId: string,
    userId: string
  ): Promise<{ granted: boolean; proven: boolean }> {
    const user = await prisma.user.findFirst({
      where: { id: userId, storeId },
      select: { phone: true },
    });
    // The profile phone is self-declared: report consent ONLY for a proven number, otherwise a user
    // could type someone else's number and learn whether that person opted in.
    if (!user?.phone || !(await phoneOnOwnOrder(storeId, userId, user.phone))) {
      return { granted: false, proven: false };
    }
    const buyerKey = await buyerKeyFor(suiteBuyerKeySecret(), user.phone);
    return { granted: buyerKey ? await this.hasConsent(storeId, buyerKey) : false, proven: true };
  },

  /** True only for an active, un-revoked consent. Unknown buyer = no consent. */
  async hasConsent(storeId: string, buyerKey: string): Promise<boolean> {
    const row = await runInTenantContext(storeId, () =>
      prisma.storeWhatsAppConsent.findUnique({
        where: { storeId_buyerKey: { storeId, buyerKey } },
        select: { granted: true },
      })
    );
    return row?.granted === true;
  },

  /**
   * Erasure: delete EVERY row this account created (any earlier number, by `userId`) and the current
   * number's row. One delete per key so the consent observer can attribute and announce each one.
   * Runs on the caller's transaction client.
   */
  async eraseForAccount(
    tx: Pick<typeof prisma, 'storeWhatsAppConsent'>,
    storeId: string,
    userId: string,
    buyerKey?: string
  ): Promise<number> {
    // Scope: rows THIS account proved (userId set by a proven grant) plus the row of its CURRENT
    // PROVEN number (`buyerKey` must be passed only when proven). A STOP-sourced opt-out on an older
    // number is KEPT (owner cleared): an opt-out must survive for that number's real owner, and
    // losing it could re-enable messages.
    const rows = await tx.storeWhatsAppConsent.findMany({
      where: { storeId, OR: [{ userId }, ...(buyerKey ? [{ buyerKey }] : [])] },
      select: { buyerKey: true, granted: true, revokedSource: true },
    });
    for (const r of rows) {
      const keepOptOut =
        r.buyerKey !== buyerKey && r.granted === false && r.revokedSource === 'whatsapp';
      if (keepOptOut) {
        await tx.storeWhatsAppConsent.updateMany({
          where: { storeId, buyerKey: r.buyerKey },
          data: { userId: null },
        });
      } else {
        await tx.storeWhatsAppConsent.deleteMany({ where: { storeId, buyerKey: r.buyerKey } });
      }
    }
    return rows.length;
  },

  /**
   * Every consent row this ACCOUNT ever created (any earlier phone, by `userId`), plus the row of the
   * current number when it is proven theirs (`includeKey`). Hashes and timestamps only, never a phone.
   */
  async exportForAccount(storeId: string, userId: string, includeKey?: string) {
    return runInTenantContext(storeId, () =>
      prisma.storeWhatsAppConsent.findMany({
        where: { storeId, OR: [{ userId }, ...(includeKey ? [{ buyerKey: includeKey }] : [])] },
        select: {
          granted: true,
          grantedAt: true,
          grantedSource: true,
          locale: true,
          revokedAt: true,
          revokedSource: true,
        },
      })
    );
  },
};

/**
 * `whatsapp.opt_out_changed` (envelope v1.1): the buyer sent STOP on WhatsApp. optedOut=true turns the
 * Store-side marketing consent OFF; optedOut=false NEVER turns it back on (that needs a fresh tick at
 * checkout). Monotonic by `version`: a version at or below the stored one is ignored.
 */
export async function applyOptOutChanged(
  storeId: string,
  buyerKey: string,
  optedOut: boolean,
  version: number
): Promise<'applied' | 'ignored'> {
  return runInTenantContext(storeId, async () => {
    const row = await prisma.storeWhatsAppConsent.findUnique({
      where: { storeId_buyerKey: { storeId, buyerKey } },
      select: { optOutVersion: true, granted: true },
    });
    if (row && row.optOutVersion >= version) return 'ignored';
    const now = new Date();
    if (!optedOut) {
      // Record the version only; consent stays as it is.
      if (!row) return 'ignored';
      await prisma.storeWhatsAppConsent.update({
        where: { storeId_buyerKey: { storeId, buyerKey } },
        data: { optOutVersion: version },
      });
      return 'ignored';
    }
    await prisma.storeWhatsAppConsent.upsert({
      where: { storeId_buyerKey: { storeId, buyerKey } },
      create: {
        storeId,
        buyerKey,
        granted: false,
        revokedAt: now,
        revokedSource: 'whatsapp',
        optOutVersion: version,
      },
      update: { granted: false, revokedAt: now, revokedSource: 'whatsapp', optOutVersion: version },
    });
    return 'applied';
  });
}
