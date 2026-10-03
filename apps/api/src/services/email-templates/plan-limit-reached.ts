import { escapeHtml } from './_util';

export interface PlanLimitReachedData {
  storeName: string;
  planName: string;
  limit: number;
  used: number;
  billingUrl: string;
}

/**
 * Merchant notice: the store passed its monthly order cap. Orders are NOT
 * blocked (customers are never failed at checkout); this tells the merchant to
 * upgrade before the platform starts enforcing a stricter policy.
 */
export const planLimitReachedTemplate = {
  subject: {
    en: (d: PlanLimitReachedData) => `${d.storeName}: you passed your monthly order limit`,
    ar: (d: PlanLimitReachedData) => `${d.storeName}: تجاوزت حد الطلبات الشهري`,
  },
  en: (d: PlanLimitReachedData) => `
    <h2>You passed your monthly order limit</h2>
    <p><strong>${escapeHtml(d.storeName)}</strong> has received ${d.used} orders this month; the
    ${escapeHtml(d.planName)} plan includes ${d.limit}.</p>
    <p>Your customers can still order — nothing is blocked. Upgrade your plan to stay within your limit.</p>
    <p><a href="${escapeHtml(d.billingUrl)}">Open billing</a></p>`,
  ar: (d: PlanLimitReachedData) => `
    <h2 dir="rtl">تجاوزت حد الطلبات الشهري</h2>
    <p dir="rtl">استقبل متجر <strong>${escapeHtml(d.storeName)}</strong> عدد ${d.used} طلبًا هذا الشهر،
    بينما تتيح باقة ${escapeHtml(d.planName)} ${d.limit} طلبًا.</p>
    <p dir="rtl">عملاؤك ما زالوا قادرين على الطلب ولم يتم حظر أي شيء. قم بترقية باقتك للبقاء ضمن الحد.</p>
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">افتح صفحة الفوترة</a></p>`,
};
