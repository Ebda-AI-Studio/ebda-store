import { escapeHtml } from './_util';

export type WholesaleNoticeKind = 'received' | 'approved' | 'rejected';

export interface WholesaleNoticeData {
  customerName: string;
  storeName: string;
  businessName: string;
  /** The merchant's decision note (rejected only). */
  note?: string | null;
}

const COPY = {
  en: {
    received: {
      subject: (d: WholesaleNoticeData) =>
        `We received your wholesale application - ${d.storeName}`,
      body: (d: WholesaleNoticeData) =>
        `<p>Thank you. We received the wholesale account application for <strong>${escapeHtml(d.businessName)}</strong> and the store will review it shortly. You will get an email when there is a decision.</p>`,
    },
    approved: {
      subject: (d: WholesaleNoticeData) => `Your wholesale account is approved - ${d.storeName}`,
      body: (d: WholesaleNoticeData) =>
        `<p>Good news: the wholesale account for <strong>${escapeHtml(d.businessName)}</strong> is approved. Sign in to see your wholesale prices on products, in your cart and at checkout.</p>`,
    },
    rejected: {
      subject: (d: WholesaleNoticeData) => `About your wholesale application - ${d.storeName}`,
      body: (d: WholesaleNoticeData) =>
        `<p>Unfortunately the wholesale application for <strong>${escapeHtml(d.businessName)}</strong> was not approved.</p>${d.note ? `<p><strong>Note from the store:</strong> ${escapeHtml(d.note)}</p>` : ''}<p>You can apply again after 30 days.</p>`,
    },
    hi: (d: WholesaleNoticeData) => `<p>Hi ${escapeHtml(d.customerName)},</p>`,
    bye: (d: WholesaleNoticeData) => `<p>Best regards,<br>${escapeHtml(d.storeName)} Team</p>`,
  },
  ar: {
    received: {
      subject: (d: WholesaleNoticeData) => `استلمنا طلب حساب الجملة - ${d.storeName}`,
      body: (d: WholesaleNoticeData) =>
        `<p>شكرًا لك. استلمنا طلب حساب الجملة الخاص بـ <strong>${escapeHtml(d.businessName)}</strong> وسيراجعه المتجر قريبًا. سنرسل لك رسالة عند صدور القرار.</p>`,
    },
    approved: {
      subject: (d: WholesaleNoticeData) => `تمت الموافقة على حساب الجملة - ${d.storeName}`,
      body: (d: WholesaleNoticeData) =>
        `<p>أخبار سارة: تمت الموافقة على حساب الجملة الخاص بـ <strong>${escapeHtml(d.businessName)}</strong>. سجّل الدخول لترى أسعار الجملة على المنتجات وفي السلة وعند إتمام الطلب.</p>`,
    },
    rejected: {
      subject: (d: WholesaleNoticeData) => `بخصوص طلب حساب الجملة - ${d.storeName}`,
      body: (d: WholesaleNoticeData) =>
        `<p>للأسف لم تتم الموافقة على طلب حساب الجملة الخاص بـ <strong>${escapeHtml(d.businessName)}</strong>.</p>${d.note ? `<p><strong>ملاحظة من المتجر:</strong> ${escapeHtml(d.note)}</p>` : ''}<p>يمكنك التقديم مرة أخرى بعد 30 يومًا.</p>`,
    },
    hi: (d: WholesaleNoticeData) => `<p>مرحبًا ${escapeHtml(d.customerName)}،</p>`,
    bye: (d: WholesaleNoticeData) => `<p>مع أطيب التحيات،<br>فريق ${escapeHtml(d.storeName)}</p>`,
  },
} as const;

/** Bilingual applicant notice (Arabic first in the storefront, so the recipient's language decides). */
export function wholesaleNotice(
  kind: WholesaleNoticeKind,
  lang: 'en' | 'ar',
  d: WholesaleNoticeData
): { subject: string; content: string } {
  const c = COPY[lang];
  return { subject: c[kind].subject(d), content: `${c.hi(d)}${c[kind].body(d)}${c.bye(d)}` };
}

export interface WholesaleMerchantNoticeData {
  storeName: string;
  businessName?: string;
  pendingCount: number;
  adminUrl: string;
}

/** Notice to the MERCHANT: a new application arrived ('received'), or applications have waited 48h+ ('nudge'). */
export function wholesaleMerchantNotice(
  kind: 'received' | 'nudge',
  lang: 'en' | 'ar',
  d: WholesaleMerchantNoticeData
): { subject: string; content: string } {
  const link = `<p><a href="${escapeHtml(d.adminUrl)}">${lang === 'ar' ? 'افتح طلبات الجملة' : 'Open wholesale applications'}</a></p>`;
  if (lang === 'ar') {
    return kind === 'received'
      ? {
          subject: `طلب حساب جملة جديد - ${d.storeName}`,
          content: `<p>وصل طلب حساب جملة جديد من <strong>${escapeHtml(d.businessName ?? '')}</strong>. العميل مستني ردك.</p><p>عدد الطلبات اللي لسه ما اتراجعتش: ${d.pendingCount}.</p>${link}`,
        }
      : {
          subject: `طلبات جملة مستنية ردك - ${d.storeName}`,
          content: `<p>فيه ${d.pendingCount} طلب حساب جملة مستني ردك بقاله أكتر من 48 ساعة. العملاء دول اتقالهم إن المتجر هيراجع طلبهم قريب.</p>${link}`,
        };
  }
  return kind === 'received'
    ? {
        subject: `New wholesale application - ${d.storeName}`,
        content: `<p>A new wholesale account application arrived from <strong>${escapeHtml(d.businessName ?? '')}</strong>. The buyer is waiting for your decision.</p><p>Applications still waiting: ${d.pendingCount}.</p>${link}`,
      }
    : {
        subject: `Wholesale applications waiting for you - ${d.storeName}`,
        content: `<p>${d.pendingCount} wholesale application${d.pendingCount === 1 ? ' has' : 's have'} been waiting more than 48 hours. These buyers were told the store would review them shortly.</p>${link}`,
      };
}
