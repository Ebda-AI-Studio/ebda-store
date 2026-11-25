/**
 * Merchant notifications for the subscription lifecycle (SP5 task 3): the bell
 * (socket notification) plus a durable email. Always called AFTER the DB
 * transaction committed; a notification failure never fails billing.
 */
import { awardGrantsAfterPayment } from './grants.service';
import { withStore } from '@ebda/database';
import { config } from '../../config';
import logger from '../../lib/logger';
import { EmailService } from '../email.service';
import { socketService } from '../socket.service';
import { featureService } from '../feature.service';
import { sendAlert } from '../alerts.service';
import { emailMoney } from '../email-templates/_util';
import { ADDON_CATALOG } from './addon-catalog';
import { bustStoreCaches } from '../store.service';
import { reconcileStoreAccess } from './account.service';
import { instapayDetails } from './account.service';
import { supportContact } from './manual-config';
import { emitEbdaConversion } from '../ebda-ads-emit';
import { purchaseEventId, billingPaymentNumber, EBDA_BILLING_BARCODE_SHAPE } from '@ebda/shared';
import { ensureEmailBarcode } from '../barcode-image.service';
import type { EmailBarcode } from '../email-templates/_barcode';

export type BillingEffect =
  | { kind: 'plan_changed'; storeId: string }
  /** An add-on / AI pack term was granted: drop the store's cached feature map. */
  | { kind: 'addon_granted'; storeId: string }
  /** Money was taken for an add-on we cannot deliver: alert and refund it (compensating action). */
  | { kind: 'addon_unapplied'; storeId: string; billingEventId: string }
  /** Tell the owner about an add-on renewal: heads-up before the charge, or why it was NOT charged (ADDON-RENEW-1). */
  | {
      kind: 'addon_notice';
      storeId: string;
      sku: string;
      reason:
        | 'renewal_upcoming'
        | 'price_changed'
        | 'now_included'
        | 'disabled'
        | 'renewal_declined'
        | 'no_card';
      endsAt: Date;
      amountMinor: number;
    }
  /** Money was recorded: lift an `unpaid` suspension, re-apply the store allowance. */
  | { kind: 'payment_recorded'; storeId: string }
  /**
   * A subscription payment succeeded (card checkout/upgrade/trial-end charge, or a manual
   * InstaPay approval). Feeds Ebda's own ads funnel; the Inngest function decides whether it
   * is the store's FIRST paid payment.
   */
  | { kind: 'subscription_paid'; storeId: string; billingEventId: string }
  /** The daily job suspended an unpaid InstaPay store (`applied` = this run did it). */
  | { kind: 'store_suspended'; storeId: string; applied: boolean }
  | {
      kind: 'payment_failed';
      storeId: string;
      amountMinor: number;
      attempt: number;
      nextRetryAt: Date;
      planCode: string;
    }
  /** The super-admin approved an InstaPay payment (audit #11). */
  | {
      kind: 'payment_confirmed';
      storeId: string;
      planCode: string;
      periodEnd: Date;
      /** The ledger row of this payment: its hashed id is the receipt's scannable number. */
      billingEventId?: string;
    }
  /** The super-admin rejected an InstaPay payment, with the reason. */
  | { kind: 'payment_rejected'; storeId: string; note: string }
  /** A billing suspension was lifted: the store is back. */
  | { kind: 'store_restored'; storeId: string; reason: 'unpaid' | 'over_store_limit' }
  | {
      kind: 'downgraded';
      storeId: string;
      reason: 'dunning' | 'canceled' | 'no_payment_method' | 'trial_ended' | 'payment_reversed';
    };

async function storeContext(storeId: string) {
  return withStore(storeId, async tx => {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        slug: true,
        domain: true,
        settings: true,
        ownerId: true,
        owner: { select: { email: true } },
      },
    });
    if (!store) return null;
    const sub = await tx.storeSubscription.findUnique({
      where: { storeId },
      select: { planCode: true },
    });
    const plans = await tx.plan.findMany({ select: { code: true, nameEn: true, nameAr: true } });
    return { store, planCode: sub?.planCode ?? 'free', plans };
  });
}

export async function runBillingEffects(effects: BillingEffect[]): Promise<void> {
  for (const effect of effects) {
    try {
      await runOne(effect);
    } catch (err) {
      logger.warn({ err, kind: effect.kind, storeId: effect.storeId }, '[billing] effect failed');
    }
  }
}

function addonNoticeCopy(
  reason: Extract<BillingEffect, { kind: 'addon_notice' }>['reason'],
  lang: 'en' | 'ar',
  v: { name: string; date: string; amount: string }
): { title: string; body: string } {
  const en = {
    renewal_upcoming: [
      `${v.name} renews on ${v.date}`,
      `${v.amount} will be charged to your saved card on ${v.date} for another 30 days of ${v.name}. To stop it, open Add-ons and press Stop renewing before then.`,
    ],
    renewal_declined: [
      `${v.name} was not renewed`,
      `The renewal payment did not go through, so ${v.name} ends on ${v.date}. You can buy it again from Add-ons.`,
    ],
    price_changed: [
      `${v.name} was not renewed: the price changed`,
      `The price of ${v.name} is no longer the one you agreed to, so we did not charge you. It ends on ${v.date}. Buy it again from Add-ons to accept the new price.`,
    ],
    now_included: [
      `${v.name} is now included in your plan`,
      `Your plan already includes ${v.name}, so we did not charge a renewal. You keep the feature.`,
    ],
    disabled: [
      `${v.name} was not renewed`,
      `${v.name} was switched off for your store by Ebda Store support, so we did not charge a renewal. Contact support if this is a mistake.`,
    ],
    no_card: [
      `${v.name} was not renewed: no saved card`,
      `There is no saved card on your store, so ${v.name} ends on ${v.date}. Save a card in Billing and buy it again from Add-ons.`,
    ],
  } as const;
  const ar = {
    renewal_upcoming: [
      `${v.name} بتتجدد يوم ${v.date}`,
      `هيتخصم ${v.amount} من الكارت المحفوظ يوم ${v.date} مقابل 30 يوم تانيين من ${v.name}. لو مش عايز تتجدد، افتح الإضافات واضغط وقّف التجديد قبل الميعاد ده.`,
    ],
    renewal_declined: [
      `${v.name} ماتجددتش`,
      `دفعة التجديد معداتش، فـ ${v.name} هتخلص يوم ${v.date}. تقدر تشتريها تاني من الإضافات.`,
    ],
    price_changed: [
      `${v.name} ماتجددتش: السعر اتغير`,
      `سعر ${v.name} بقى مختلف عن اللي وافقت عليه، فمخصمناش منك حاجة. هتخلص يوم ${v.date}. اشتريها تاني من الإضافات لو موافق على السعر الجديد.`,
    ],
    now_included: [
      `${v.name} بقت موجودة في باقتك`,
      `باقتك بقت فيها ${v.name}، فمخصمناش تجديد. والميزة فضلت معاك.`,
    ],
    disabled: [
      `${v.name} ماتجددتش`,
      `دعم ابدأ ستور قفل ${v.name} لمتجرك، فمخصمناش تجديد. كلّم الدعم لو ده حصل بالغلط.`,
    ],
    no_card: [
      `${v.name} ماتجددتش: مفيش كارت محفوظ`,
      `مفيش كارت محفوظ على متجرك، فـ ${v.name} هتخلص يوم ${v.date}. احفظ كارت من الفوترة واشتريها تاني من الإضافات.`,
    ],
  } as const;
  const [title, body] = (lang === 'ar' ? ar : en)[reason];
  return { title, body };
}

async function runOne(effect: BillingEffect): Promise<void> {
  if (effect.kind === 'addon_granted') {
    // A grant AND a refund: the entitlement changed, so every layer drops at once (feature map, then the public
    // store payload that lists the store's features; the latter has its own TTL).
    await featureService.invalidateCache(effect.storeId);
    const ctx = await storeContext(effect.storeId);
    if (ctx) await bustStoreCaches(effect.storeId, ctx.store.slug, ctx.store.domain);
    return;
  }
  if (effect.kind === 'addon_unapplied') {
    void sendAlert({
      level: 'p1',
      title: 'Add-on paid but not deliverable: refunding',
      body: `billing_events ${effect.billingEventId} (store ${effect.storeId}) could not be delivered (unknown add-on, or a support override is on). A refund was attempted.`,
    }).catch(() => undefined);
    // Lazy import: subscription-billing imports this module.
    const { refundCharge } = await import('./subscription-billing.service.js');
    await refundCharge({ eventId: effect.billingEventId });
    return;
  }
  const ctx = await storeContext(effect.storeId);
  if (!ctx) return;
  const { store } = ctx;
  if (effect.kind === 'addon_notice') {
    const lang: 'en' | 'ar' =
      (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en'
        ? 'en'
        : 'ar';
    const item = ADDON_CATALOG[effect.sku];
    const name = item ? (lang === 'ar' ? item.nameAr : item.nameEn) : effect.sku;
    const date = effect.endsAt.toISOString().slice(0, 10);
    const amount = emailMoney(effect.amountMinor, 'EGP', lang);
    const url = `${config.adminUrl ?? ''}/stores/${effect.storeId}/billing/addons`;
    const copy = addonNoticeCopy(effect.reason, lang, { name, date, amount });
    socketService.notifyStore(effect.storeId, {
      type: 'billing_addon_notice',
      title: copy.title,
      message: copy.body,
      data: { storeId: effect.storeId, url },
      createdAt: new Date(),
    });
    if (store.owner?.email)
      await EmailService.sendAddonNotice(effect.storeId, store.owner.email, copy, url, lang);
    return;
  }
  if (effect.kind === 'subscription_paid') {
    // FOUNDING-1: founding-20 + referral free months (idempotent, never throws)
    await awardGrantsAfterPayment(effect.storeId);
    await emitEbdaConversion({
      name: 'Purchase',
      eventId: purchaseEventId(effect.billingEventId),
      userId: store.ownerId,
      storeId: effect.storeId,
      billingEventId: effect.billingEventId,
    });
    return;
  }
  if (effect.kind === 'plan_changed' || effect.kind === 'downgraded') {
    await featureService.invalidateCache(effect.storeId);
    await bustStoreCaches(effect.storeId, store.slug, store.domain);
  }
  // Any plan or payment change can move the owner's store allowance (a Business
  // lapse suspends the extra stores; a payment lifts an unpaid suspension).
  if (
    effect.kind === 'plan_changed' ||
    effect.kind === 'downgraded' ||
    effect.kind === 'payment_recorded'
  ) {
    await reconcileStoreAccess(effect.storeId);
  }
  if (effect.kind === 'plan_changed' || effect.kind === 'payment_recorded') return;

  const lang: 'en' | 'ar' =
    (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';
  const url = `/stores/${effect.storeId}/billing`;
  const planRow = ctx.plans.find(
    p =>
      p.code ===
      (effect.kind === 'payment_failed' || effect.kind === 'payment_confirmed'
        ? effect.planCode
        : ctx.planCode)
  );
  const planName = planRow ? (lang === 'ar' ? planRow.nameAr : planRow.nameEn) : '';

  if (
    effect.kind === 'payment_confirmed' ||
    effect.kind === 'payment_rejected' ||
    effect.kind === 'store_restored'
  ) {
    const until =
      effect.kind === 'payment_confirmed' ? effect.periodEnd.toISOString().slice(0, 10) : '';
    const copy =
      effect.kind === 'payment_confirmed'
        ? {
            type: 'billing_payment_confirmed',
            title: lang === 'ar' ? 'تم تأكيد دفعتك' : 'Your payment is confirmed',
            message:
              lang === 'ar'
                ? `باقة ${planName} مدفوعة حتى ${until}. شكرًا لك.`
                : `${planName} is paid until ${until}. Thank you.`,
          }
        : effect.kind === 'payment_rejected'
          ? {
              type: 'billing_payment_rejected',
              title:
                lang === 'ar'
                  ? 'لم نقبل إيصال التحويل'
                  : 'We could not accept your transfer receipt',
              message:
                lang === 'ar'
                  ? `السبب: ${effect.note}. افتح صفحة الاشتراك وارفع الإيصال الصحيح.`
                  : `Reason: ${effect.note}. Open billing and upload the right receipt.`,
            }
          : {
              type: 'billing_store_restored',
              title: lang === 'ar' ? 'متجرك رجع يشتغل' : 'Your store is back',
              message:
                lang === 'ar'
                  ? 'واجهة المتجر متاحة للعملاء من جديد وتستقبل الطلبات.'
                  : 'Your storefront is open to shoppers again and takes orders.',
            };
    socketService.notifyStore(effect.storeId, {
      type: copy.type,
      title: copy.title,
      message: copy.message,
      data: { storeId: effect.storeId, url },
      createdAt: new Date(),
    });
    // The receipt barcode (palm, Ebda's own billing shape): ready or not, the notice goes out.
    let barcode: EmailBarcode | null = null;
    let paymentNumber: string | undefined;
    if (effect.kind === 'payment_confirmed' && effect.billingEventId) {
      paymentNumber = billingPaymentNumber(effect.billingEventId);
      barcode = await ensureEmailBarcode({
        storeId: effect.storeId,
        kind: 'billing',
        number: paymentNumber,
        shape: EBDA_BILLING_BARCODE_SHAPE,
      }).catch(() => null);
    }
    if (store.owner?.email) {
      await EmailService.sendSubscriptionBillingNotice(
        effect.storeId,
        {
          kind: effect.kind,
          to: store.owner.email,
          storeName: store.name,
          planName,
          amountMinor: 0,
          billingUrl: `${config.adminUrl ?? ''}${url}`,
          paidUntil: until || undefined,
          reason: effect.kind === 'payment_rejected' ? effect.note : undefined,
          barcode,
          paymentNumber,
          whatsappUrl: supportContact(store.name).whatsappUrl,
          supportEmail: supportContact(store.name).email,
        },
        lang
      );
    }
    return;
  }

  if (effect.kind === 'store_suspended') {
    if (!effect.applied) return;
    socketService.notifyStore(effect.storeId, {
      type: 'billing_store_suspended',
      title: lang === 'ar' ? 'تم إيقاف متجرك مؤقتًا' : 'Your store is paused',
      message:
        lang === 'ar'
          ? 'لم نستلم الدفعة. ادفع لإعادة المتجر فورًا.'
          : 'We have not received the payment. Pay to bring the store back at once.',
      data: { storeId: effect.storeId, url },
      createdAt: new Date(),
    });
    if (store.owner?.email) {
      const ip = await instapayDetails(effect.storeId);
      await EmailService.sendSubscriptionBillingNotice(
        effect.storeId,
        {
          kind: 'store_suspended',
          to: store.owner.email,
          storeName: store.name,
          planName,
          amountMinor: ip?.amountMinor ?? 0,
          vat: ip?.vat ?? null,
          billingUrl: `${config.adminUrl ?? ''}${url}`,
          method: 'instapay',
          instapayHandle: ip?.handle ?? null,
          paymentReference: ip?.reference ?? null,
          whatsappUrl: supportContact(store.name).whatsappUrl,
          supportEmail: supportContact(store.name).email,
        },
        lang
      );
    }
    return;
  }

  if (effect.kind === 'payment_failed') {
    const retryOn = effect.nextRetryAt.toISOString().slice(0, 10);
    socketService.notifyStore(effect.storeId, {
      type: 'billing_payment_failed',
      title: lang === 'ar' ? 'تعذّر تجديد الاشتراك' : 'Subscription payment failed',
      message:
        lang === 'ar'
          ? `سنعيد المحاولة في ${retryOn}. حدّث وسيلة الدفع.`
          : `We will retry on ${retryOn}. Update your payment method.`,
      data: { storeId: effect.storeId, url, retryOn },
      createdAt: new Date(),
    });
    if (store.owner?.email) {
      await EmailService.sendSubscriptionBillingNotice(
        effect.storeId,
        {
          kind: 'payment_failed',
          to: store.owner.email,
          storeName: store.name,
          planName,
          amountMinor: effect.amountMinor,
          retryOn,
          billingUrl: `${config.adminUrl ?? ''}${url}`,
        },
        lang
      );
    }
    return;
  }

  // downgraded
  socketService.notifyStore(effect.storeId, {
    type: 'billing_downgraded',
    // A canceled store takes NO new orders (plan-limit `SUBSCRIPTION_REQUIRED`): say so
    // (audit #1 / B2) — never "Free plan limits apply", which promised orders.
    title: lang === 'ar' ? 'الطلبات الجديدة متوقفة' : 'New orders are paused',
    message:
      lang === 'ar'
        ? 'اشتراكك انتهى، فالمتجر مش هيستقبل طلبات جديدة. بياناتك محفوظة. اختار باقة وادفع عشان يرجع يشتغل.'
        : 'Your subscription ended, so the store takes no new orders. Your data is kept. Choose a plan and pay to bring it back.',
    data: { storeId: effect.storeId, url, reason: effect.reason },
    createdAt: new Date(),
  });
  if (store.owner?.email && effect.reason !== 'canceled') {
    await EmailService.sendSubscriptionBillingNotice(
      effect.storeId,
      {
        kind: 'downgraded',
        to: store.owner.email,
        storeName: store.name,
        planName,
        amountMinor: 0,
        billingUrl: `${config.adminUrl ?? ''}${url}`,
      },
      lang
    );
  }
}
