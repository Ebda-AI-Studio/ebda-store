import { escapeHtml } from './_util';

/**
 * Merchant notices about the gold rate (Phase B5 Task 11, Rulings B5-16, B5-20). Egyptian Arabic
 * sentences, neutral button labels. No provider is ever named here (the provider-name gate scans
 * this directory): the automatic rate is just "السعر التلقائي" / "the automatic rate".
 */
export interface GoldRateNoticeData {
  storeName: string;
  adminUrl: string;
  /** Hours since the last rate was recorded (warning / blocked). */
  hours?: number;
  /** The store's max age in hours (warning / blocked). */
  maxHours?: number;
  /** A pending automatic rate (pending). */
  karat?: number;
  /** Egyptian pounds per gram, formatted by the caller (pending). */
  rateText?: string;
  /** The jump in percent, formatted by the caller (pending). */
  jumpText?: string;
  /** The two feed values for a disagreement, formatted by the caller (disagree). */
  primaryText?: string;
  fallbackText?: string;
}

const button = (data: GoldRateNoticeData, label: string) => `
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(data.adminUrl)}/gold-rates" class="button">${label}</a>
    </p>`;

export const goldRateWarningTemplate = {
  subject: {
    en: () => 'Update your gold rate so the store keeps selling',
    ar: () => 'حدّث سعر الدهب عشان المحل يفضل يبيع',
  },
  en: (d: GoldRateNoticeData) => `
    <h2>Update today's gold rate</h2>
    <p>The last gold rate for <strong>${escapeHtml(d.storeName)}</strong> was recorded ${d.hours ?? '?'} hours ago.
    After ${d.maxHours ?? 26} hours orders for pieces priced by gold are paused until you update it.</p>${button(d, 'Update rate')}`,
  ar: (d: GoldRateNoticeData) => `
    <h2>حدّث سعر الدهب النهارده</h2>
    <p>آخر سعر دهب اتسجّل لـ <strong>${escapeHtml(d.storeName)}</strong> من ${d.hours ?? '?'} ساعة. لو عدّى ${d.maxHours ?? 26} ساعة هنوقّف الطلبات على القطع اللي بتتسعّر بالدهب لحد ما تحدّثه.</p>${button(d, 'تحديث السعر')}`,
};

export const goldRateBlockedTemplate = {
  subject: {
    en: () => 'Orders on gold-priced pieces are paused: update the rate',
    ar: () => 'البيع واقف على قطع الدهب: حدّث السعر',
  },
  en: (d: GoldRateNoticeData) => `
    <h2>Selling gold-priced pieces is paused</h2>
    <p>The gold rate for <strong>${escapeHtml(d.storeName)}</strong> is ${d.hours ?? '?'} hours old, past the ${d.maxHours ?? 26} hour limit.
    Shoppers cannot order pieces priced by gold until you update it. Other products are not affected.</p>${button(d, 'Update rate')}`,
  ar: (d: GoldRateNoticeData) => `
    <h2>البيع واقف على قطع الدهب</h2>
    <p>سعر الدهب في <strong>${escapeHtml(d.storeName)}</strong> قديم، من ${d.hours ?? '?'} ساعة وعدّى حد الـ ${d.maxHours ?? 26} ساعة. الزبون مش هيقدر يطلب القطع اللي بتتسعّر بالدهب لحد ما تحدّث السعر. باقي المنتجات شغالة عادي.</p>${button(d, 'تحديث السعر')}`,
};

export const goldRatePendingTemplate = {
  subject: {
    en: () => 'A new automatic gold rate is waiting for your confirmation',
    ar: () => 'سعر تلقائي جديد مستني تأكيدك',
  },
  en: (d: GoldRateNoticeData) => `
    <h2>Confirm the new automatic rate</h2>
    <p>The automatic ${d.karat ?? 21}k rate for <strong>${escapeHtml(d.storeName)}</strong> moved by ${escapeHtml(d.jumpText ?? '')} to ${escapeHtml(d.rateText ?? '')} per gram.
    It was not applied. Confirm it or reject it; prices stay as they are until you decide.</p>${button(d, 'Review')}`,
  ar: (d: GoldRateNoticeData) => `
    <h2>أكّد السعر التلقائي الجديد</h2>
    <p>سعر عيار ${d.karat ?? 21} التلقائي في <strong>${escapeHtml(d.storeName)}</strong> اتحرّك ${escapeHtml(d.jumpText ?? '')} لحد ${escapeHtml(d.rateText ?? '')} للجرام. لسه مستني قرارك ومش متطبّق على الأسعار. أكّده أو ارفضه، والأسعار هتفضل زي ما هي لحد ما تقرّر.</p>${button(d, 'مراجعة')}`,
};

export const goldRateDisagreeTemplate = {
  subject: {
    en: () => 'The two gold rate sources disagree: you decide',
    ar: () => 'مصدرين سعر الدهب مختلفين: القرار قرارك',
  },
  en: (d: GoldRateNoticeData) => `
    <h2>The automatic gold rate needs your decision</h2>
    <p>The two automatic sources for <strong>${escapeHtml(d.storeName)}</strong> differ by ${escapeHtml(d.jumpText ?? '')}:
    ${escapeHtml(d.primaryText ?? '')} per gram (24k) against ${escapeHtml(d.fallbackText ?? '')}.
    Nothing was applied and your current rate stays in force. Pick one of them, type your own rate, or keep the current rate.</p>${button(d, 'Decide')}`,
  ar: (d: GoldRateNoticeData) => `
    <h2>سعر الدهب التلقائي مستني قرارك</h2>
    <p>المصدرين التلقائيين لـ <strong>${escapeHtml(d.storeName)}</strong> مختلفين ${escapeHtml(d.jumpText ?? '')}:
    ${escapeHtml(d.primaryText ?? '')} للجرام (عيار 24) قصاد ${escapeHtml(d.fallbackText ?? '')}.
    مفيش حاجة اتطبقت وسعرك الحالي لسه شغال. اختار واحد منهم، أو اكتب سعرك بنفسك، أو سيب السعر الحالي.</p>${button(d, 'قرّر')}`,
};

export type GoldRateNoticeKind = 'warning' | 'blocked' | 'pending' | 'disagree';
export const GOLD_RATE_NOTICES = {
  warning: goldRateWarningTemplate,
  blocked: goldRateBlockedTemplate,
  pending: goldRatePendingTemplate,
  disagree: goldRateDisagreeTemplate,
} as const;
