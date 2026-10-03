/**
 * Merchant notifications for the subscription lifecycle (SP5 task 3): the bell
 * (socket notification) plus a durable email. Always called AFTER the DB
 * transaction committed; a notification failure never fails billing.
 */
import { withRlsBypass } from '@force/database';
import { config } from '../../config';
import logger from '../../lib/logger';
import { EmailService } from '../email.service';
import { socketService } from '../socket.service';
import { featureService } from '../feature.service';
import { bustStoreCaches } from '../store.service';

export type BillingEffect =
  | { kind: 'plan_changed'; storeId: string }
  | {
      kind: 'payment_failed';
      storeId: string;
      amountMinor: number;
      attempt: number;
      nextRetryAt: Date;
      planCode: string;
    }
  | { kind: 'downgraded'; storeId: string; reason: 'dunning' | 'canceled' | 'no_payment_method' };

async function storeContext(storeId: string) {
  return withRlsBypass(async tx => {
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
  if (effect.kind === 'plan_changed') return;

  const lang: 'en' | 'ar' =
    (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';
  const url = `/stores/${effect.storeId}/billing`;
  const planRow = ctx.plans.find(
    p => p.code === (effect.kind === 'payment_failed' ? effect.planCode : ctx.planCode)
  );
  const planName = planRow ? (lang === 'ar' ? planRow.nameAr : planRow.nameEn) : '';

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
