import { escapeHtml } from './_util';

export interface WebhookDisabledData {
  storeName: string;
  endpointUrl: string;
  failures: number;
  webhooksUrl: string;
}

/** Merchant notice: an endpoint was switched off after repeated failed deliveries. */
export const webhookDisabledTemplate = {
  subject: {
    en: (d: WebhookDisabledData) => `${d.storeName}: a webhook endpoint was turned off`,
    ar: (d: WebhookDisabledData) => `${d.storeName}: اتوقفت نقطة استقبال ويب هوك`,
  },
  en: (d: WebhookDisabledData) => `
    <h2>A webhook endpoint was turned off</h2>
    <p>Your last ${d.failures} events to <strong dir="ltr">${escapeHtml(d.endpointUrl)}</strong> could not be delivered, so we stopped sending to it.</p>
    <p>Check that your server is up and answers with a 2xx status, then turn the endpoint back on. Events that happened while it was off are not re-sent automatically.</p>
    <p><a href="${escapeHtml(d.webhooksUrl)}">Open webhooks</a></p>`,
  ar: (d: WebhookDisabledData) => `
    <h2 dir="rtl">اتوقفت نقطة استقبال ويب هوك</h2>
    <p dir="rtl">آخر ${d.failures} أحداث بعتناها على <strong dir="ltr">${escapeHtml(d.endpointUrl)}</strong> ماوصلتش، فوقفنا الإرسال ليها.</p>
    <p dir="rtl">تأكد أن السيرفر شغال وبيرد بحالة 2xx، وبعدها شغّل النقطة من جديد. الأحداث اللي حصلت وهي موقوفة مش بتتبعت تلقائيًا.</p>
    <p dir="rtl"><a href="${escapeHtml(d.webhooksUrl)}">افتح صفحة ويب هوك</a></p>`,
};
