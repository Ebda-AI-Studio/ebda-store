import { escapeHtml, emailMoney } from './_util';

export type SubscriptionBillingNoticeKind = 'payment_failed' | 'downgraded';

export interface SubscriptionBillingNoticeData {
  kind: SubscriptionBillingNoticeKind;
  storeName: string;
  planName: string;
  amountMinor: number;
  /** payment_failed: when the next automatic retry happens (ISO date text). */
  retryOn?: string;
  billingUrl: string;
}

/**
 * Merchant notices from the subscription dunning cycle (SP5 task 3): a failed
 * renewal (a retry is scheduled) and the final downgrade to the free plan.
 * The store and its data are kept — only the paid limits stop applying.
 */
export const subscriptionBillingTemplate = {
  subject: {
    en: (d: SubscriptionBillingNoticeData) =>
      d.kind === 'payment_failed'
        ? `${d.storeName}: we could not renew your ${d.planName} plan`
        : `${d.storeName}: your plan was moved to Free`,
    ar: (d: SubscriptionBillingNoticeData) =>
      d.kind === 'payment_failed'
        ? `${d.storeName}: تعذّر تجديد باقة ${d.planName}`
        : `${d.storeName}: تم نقل باقتك إلى المجانية`,
  },
  en: (d: SubscriptionBillingNoticeData) =>
    d.kind === 'payment_failed'
      ? `
    <h2>We could not renew your plan</h2>
    <p>The ${escapeHtml(emailMoney(d.amountMinor, 'EGP', 'en'))} charge for the
    <strong>${escapeHtml(d.planName)}</strong> plan on <strong>${escapeHtml(d.storeName)}</strong> did not go through.
    We will try your card again on ${escapeHtml(d.retryOn ?? 'the next retry date')}. Your store keeps working meanwhile.</p>
    <p><a href="${escapeHtml(d.billingUrl)}">Update your payment method</a></p>`
      : `
    <h2>Your plan was moved to Free</h2>
    <p>We could not collect the payment for <strong>${escapeHtml(d.storeName)}</strong> after several attempts, so the store
    is now on the Free plan. Nothing was deleted — your products, orders and settings are kept, and the Free plan limits apply.</p>
    <p><a href="${escapeHtml(d.billingUrl)}">Choose a plan to upgrade again</a></p>`,
  ar: (d: SubscriptionBillingNoticeData) =>
    d.kind === 'payment_failed'
      ? `
    <h2 dir="rtl">تعذّر تجديد باقتك</h2>
    <p dir="rtl">لم تتم عملية الدفع بمبلغ ${escapeHtml(emailMoney(d.amountMinor, 'EGP', 'ar'))} لباقة
    <strong>${escapeHtml(d.planName)}</strong> الخاصة بمتجر <strong>${escapeHtml(d.storeName)}</strong>.
    سنحاول خصم المبلغ من بطاقتك مرة أخرى في ${escapeHtml(d.retryOn ?? 'موعد المحاولة التالية')}. يستمر متجرك في العمل خلال ذلك.</p>
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">حدّث وسيلة الدفع</a></p>`
      : `
    <h2 dir="rtl">تم نقل باقتك إلى المجانية</h2>
    <p dir="rtl">لم نتمكن من تحصيل الدفعة لمتجر <strong>${escapeHtml(d.storeName)}</strong> بعد عدة محاولات، لذلك أصبح المتجر على الباقة المجانية.
    لم يُحذف أي شيء — منتجاتك وطلباتك وإعداداتك محفوظة، وتسري حدود الباقة المجانية.</p>
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">اختر باقة للترقية من جديد</a></p>`,
};
