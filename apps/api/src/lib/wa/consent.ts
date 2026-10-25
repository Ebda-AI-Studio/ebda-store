/**
 * WhatsApp MARKETING consent (Ruling WA-CONSENT-1). Cart reminders are marketing (Meta classifies them
 * as marketing templates; PDPL needs prior consent for electronic marketing), so `cart.abandoned` is
 * emitted ONLY for a buyer with an active consent. Order, COD and shipping messages are transactional
 * and never read this. Consent is unticked by default, recorded with time, source and the label
 * language, revocable (the buyer, the merchant, or a STOP on WhatsApp), exported with the account and
 * erased with it. It is keyed by the suite buyer key, so it holds no raw phone.
 */
import { prisma, runInTenantContext } from '@ebda/database';
import { buyerKeyFor } from '@ebda/shared';
import { suiteBuyerKeySecret } from './config';

export type ConsentSource = 'checkout' | 'cart' | 'admin' | 'whatsapp';

export interface ConsentInput {
  consent: boolean;
  source: ConsentSource;
  locale?: 'en' | 'ar';
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
    await runInTenantContext(storeId, () =>
      prisma.storeWhatsAppConsent.upsert({
        where: { storeId_buyerKey: { storeId, buyerKey } },
        create: input.consent
          ? {
              storeId,
              buyerKey,
              granted: true,
              grantedAt: now,
              grantedSource: input.source,
              locale: input.locale ?? null,
            }
          : { storeId, buyerKey, granted: false, revokedAt: now, revokedSource: input.source },
        update: input.consent
          ? {
              granted: true,
              grantedAt: now,
              grantedSource: input.source,
              locale: input.locale ?? null,
              revokedAt: null,
              revokedSource: null,
            }
          : { granted: false, revokedAt: now, revokedSource: input.source },
      })
    );
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
    { status: 'recorded'; granted: boolean; cartId: string } | { status: 'no_cart' | 'no_phone' }
  > {
    const cart = await prisma.cart.findFirst({
      where: { storeId, sessionId, customerId: userId },
      select: { id: true },
    });
    if (!cart) return { status: 'no_cart' };
    const user = await prisma.user.findFirst({
      where: { id: userId, storeId },
      select: { phone: true },
    });
    if (!user?.phone) return { status: 'no_phone' };
    const r = await this.record(storeId, user.phone, {
      consent: input.consent,
      source: 'checkout',
      locale: input.locale,
    });
    if (!r) return { status: 'no_phone' };
    return { status: 'recorded', granted: r.granted, cartId: cart.id };
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

  /** The buyer's consent rows for the account export (no phone is stored, only the key). */
  async exportFor(storeId: string, buyerKey: string) {
    return runInTenantContext(storeId, () =>
      prisma.storeWhatsAppConsent.findMany({
        where: { storeId, buyerKey },
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

  /** Erasure: the consent row goes with the account. */
  async eraseFor(storeId: string, buyerKey: string): Promise<void> {
    await runInTenantContext(storeId, () =>
      prisma.storeWhatsAppConsent.deleteMany({ where: { storeId, buyerKey } })
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
