/**
 * Merchant notifications for the subscription lifecycle (SP5 task 3): the bell
 * (socket notification) plus a durable email. Always called AFTER the DB
 * transaction committed; a notification failure never fails billing.
 */
import { withStore } from '@force/database';
import { config } from '../../config';
import logger from '../../lib/logger';
import { EmailService } from '../email.service';
import { socketService } from '../socket.service';
import { featureService } from '../feature.service';
import { bustStoreCaches } from '../store.service';
import { reconcileStoreAccess } from './account.service';
import { instapayDetails } from './account.service';
import { supportContact } from './manual-config';

export type BillingEffect =
  | { kind: 'plan_changed'; storeId: string }
  /** Money was recorded: lift an `unpaid` suspension, re-apply the store allowance. */
  | { kind: 'payment_recorded'; storeId: string }
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
  | {
      kind: 'downgraded';
      storeId: string;
      reason: 'dunning' | 'canceled' | 'no_payment_method' | 'trial_ended';
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

async function runOne(effect: BillingEffect): Promise<void> {
  const ctx = await storeContext(effect.storeId);
  if (!ctx) return;
  const { store } = ctx;
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
    p => p.code === (effect.kind === 'payment_failed' ? effect.planCode : ctx.planCode)
  );
  const planName = planRow ? (lang === 'ar' ? planRow.nameAr : planRow.nameEn) : '';

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
    title: lang === 'ar' ? 'تم نقل متجرك إلى الباقة المجانية' : 'Your store moved to the Free plan',
    message:
      lang === 'ar'
        ? 'بياناتك محفوظة وتسري حدود الباقة المجانية.'
        : 'Your data is kept; Free plan limits now apply.',
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
