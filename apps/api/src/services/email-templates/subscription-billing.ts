import { BRAND } from '@ebda/shared';
import { escapeHtml, emailMoney } from './_util';
import { barcodeImgHtml, type EmailBarcode } from './_barcode';

export type SubscriptionBillingNoticeKind =
  | 'payment_failed'
  | 'downgraded'
  | 'payment_due'
  | 'store_suspended'
  | 'grace_started'
  | 'grace_ending'
  | 'payment_confirmed'
  | 'payment_rejected'
  | 'store_restored';

export interface SubscriptionBillingNoticeData {
  kind: SubscriptionBillingNoticeKind;
  storeName: string;
  planName: string;
  amountMinor: number;
  /** payment_confirmed: the date the paid period ends (ISO date text). */
  paidUntil?: string;
  /** payment_rejected: the reviewer's reason. */
  reason?: string;
  /** payment_failed: when the next automatic retry happens (ISO date text). */
  retryOn?: string;
  billingUrl: string;
  /** payment_confirmed: the palm barcode PNG of `paymentNumber` (null/absent = text only). */
  barcode?: EmailBarcode | null;
  paymentNumber?: string;
  /** payment_due: the due date (ISO date text) and whole days left (0 = today). */
  dueOn?: string;
  daysLeft?: number;
  /** grace_started / grace_ending: the date the store is paused if still unpaid (ISO date text). */
  suspendOn?: string;
  /** payment_due / store_suspended: how this subscription is paid. */
  method?: 'card' | 'instapay';
  cardLast4?: string | null;
  /** InstaPay: where to send the money and the reference to write on the transfer. */
  instapayHandle?: string | null;
  paymentReference?: string | null;
  /** wa.me link to Ebda support (no WhatsApp API is used); null = not configured. */
  whatsappUrl?: string | null;
  /** Ebda support email: the contact shown when there is no WhatsApp link. */
  supportEmail?: string | null;
  /** Ebda VAT inside `amountMinor` (null/absent = no VAT wording at all). */
  vat?: {
    netMinor: number;
    vatMinor: number;
    rateBps: number;
    trn: string | null;
    legalName: string | null;
  } | null;
}

/** "14" / "2.5" from basis points. */
const pct = (bps: number) => String(Math.round(bps) / 100);

/** The VAT line under the amount, only when Ebda's VAT applies (Ruling EBDA-BILLFU-3). */
function vatLine(d: SubscriptionBillingNoticeData, lang: 'en' | 'ar'): string {
  const v = d.vat;
  if (!v || v.vatMinor <= 0) return '';
  const vat = escapeHtml(emailMoney(v.vatMinor, 'EGP', lang));
  const net = escapeHtml(emailMoney(v.netMinor, 'EGP', lang));
  const seller = v.legalName ? ` ${escapeHtml(v.legalName)}` : '';
  const trnAr = v.trn ? `، رقم التسجيل الضريبي <span dir="ltr">${escapeHtml(v.trn)}</span>` : '';
  const trnEn = v.trn ? `, tax registration number ${escapeHtml(v.trn)}` : '';
  return lang === 'ar'
    ? `<p dir="rtl">يشمل المبلغ ضريبة القيمة المضافة ${pct(v.rateBps)}% (${vat}) على ${net}.${seller ? `${seller}${trnAr}.` : ''}</p>`
    : `<p>The amount includes VAT ${pct(v.rateBps)}% (${vat}) on ${net}.${seller ? `${seller}${trnEn}.` : ''}</p>`;
}

function instapayBlock(d: SubscriptionBillingNoticeData, lang: 'en' | 'ar'): string {
  if (d.method !== 'instapay' || !d.instapayHandle) return '';
  const dir = lang === 'ar' ? ' dir="rtl"' : '';
  return lang === 'ar'
    ? `<p${dir}>حوّل المبلغ عبر إنستاباي إلى <strong dir="ltr">${escapeHtml(d.instapayHandle)}</strong>
    واكتب المرجع <strong dir="ltr">${escapeHtml(d.paymentReference ?? '')}</strong> في الملاحظات، ثم أرسل مرجع العملية من صفحة الفواتير.</p>`
    : `<p>Send the amount by InstaPay to <strong>${escapeHtml(d.instapayHandle)}</strong>
    with the reference <strong>${escapeHtml(d.paymentReference ?? '')}</strong> in the note, then submit the transfer reference on your billing page.</p>`;
}

/**
 * How to reach Ebda: the wa.me link when configured, otherwise the support
 * email. Never an empty wa.me link (Ruling EBDA-BILLFU-2).
 */
function whatsappLine(d: SubscriptionBillingNoticeData, lang: 'en' | 'ar'): string {
  if (d.whatsappUrl) {
    return lang === 'ar'
      ? `<p dir="rtl"><a href="${escapeHtml(d.whatsappUrl)}">راسلنا على واتساب</a></p>`
      : `<p><a href="${escapeHtml(d.whatsappUrl)}">Message us on WhatsApp</a></p>`;
  }
  if (!d.supportEmail) return '';
  const mail = escapeHtml(d.supportEmail);
  return lang === 'ar'
    ? `<p dir="rtl">أسئلة؟ راسلنا على <a href="mailto:${mail}" dir="ltr">${mail}</a></p>`
    : `<p>Questions? Email us at <a href="mailto:${mail}">${mail}</a></p>`;
}

function dueText(d: SubscriptionBillingNoticeData, lang: 'en' | 'ar'): string {
  const amount = escapeHtml(emailMoney(d.amountMinor, 'EGP', lang));
  const plan = escapeHtml(d.planName);
  const on = escapeHtml(d.dueOn ?? '');
  if (lang === 'ar') {
    return d.method === 'card'
      ? `سنخصم ${amount} لباقة <strong>${plan}</strong> من بطاقتك${d.cardLast4 ? ` المنتهية بـ <span dir="ltr">${escapeHtml(d.cardLast4)}</span>` : ''} في ${on}.`
      : `يستحق دفع ${amount} لباقة <strong>${plan}</strong> في ${on}.`;
  }
  return d.method === 'card'
    ? `We will charge ${amount} for the <strong>${plan}</strong> plan to your card${d.cardLast4 ? ` ending ${escapeHtml(d.cardLast4)}` : ''} on ${on}.`
    : `${amount} for the <strong>${plan}</strong> plan is due on ${on}.`;
}

/** Money batch A notices: the review outcome of an InstaPay payment, and the store coming back. */
function reviewNotice(d: SubscriptionBillingNoticeData, lang: 'en' | 'ar'): string | null {
  const store = escapeHtml(d.storeName);
  const link = escapeHtml(d.billingUrl);
  if (lang === 'ar') {
    if (d.kind === 'payment_confirmed')
      return `
    <h2 dir="rtl">تم تأكيد دفعتك</h2>
    <p dir="rtl">فريق ${BRAND.company.shortNameAr} راجع تحويل إنستاباي الخاص بمتجر <strong>${store}</strong> وأكّده. باقة <strong>${escapeHtml(d.planName)}</strong> مدفوعة حتى ${escapeHtml(d.paidUntil ?? '')}.</p>${barcodeImgHtml(d.barcode, d.paymentNumber ?? '', 'ar', 'billing')}
    <p dir="rtl"><a href="${link}">افتح صفحة الاشتراك</a></p>`;
    if (d.kind === 'payment_rejected')
      return `
    <h2 dir="rtl">لم نقبل إيصال التحويل</h2>
    <p dir="rtl">فريق ${BRAND.company.shortNameAr} راجع الإيصال الخاص بمتجر <strong>${store}</strong> ولم يقبله. السبب: ${escapeHtml(d.reason ?? '')}</p>
    <p dir="rtl">افتح صفحة الاشتراك وارفع إيصال التحويل الصحيح، أو كلّمنا.</p>
    <p dir="rtl"><a href="${link}">افتح صفحة الاشتراك</a></p>
    ${whatsappLine(d, 'ar')}`;
    if (d.kind === 'store_restored')
      return `
    <h2 dir="rtl">متجرك رجع يشتغل</h2>
    <p dir="rtl">واجهة متجر <strong>${store}</strong> متاحة للعملاء من جديد وتستقبل الطلبات.</p>
    <p dir="rtl"><a href="${link}">افتح صفحة الاشتراك</a></p>`;
    return null;
  }
  if (d.kind === 'payment_confirmed')
    return `
    <h2>Your payment is confirmed</h2>
    <p>The ${BRAND.company.shortNameEn} team checked the InstaPay transfer for <strong>${store}</strong> and confirmed it. The <strong>${escapeHtml(d.planName)}</strong> plan is paid until ${escapeHtml(d.paidUntil ?? '')}.</p>${barcodeImgHtml(d.barcode, d.paymentNumber ?? '', 'en', 'billing')}
    <p><a href="${link}">Open billing</a></p>`;
  if (d.kind === 'payment_rejected')
    return `
    <h2>We could not accept your transfer receipt</h2>
    <p>The ${BRAND.company.shortNameEn} team checked the receipt for <strong>${store}</strong> and could not accept it. Reason: ${escapeHtml(d.reason ?? '')}</p>
    <p>Open billing and upload the right transfer receipt, or contact us.</p>
    <p><a href="${link}">Open billing</a></p>
    ${whatsappLine(d, 'en')}`;
  if (d.kind === 'store_restored')
    return `
    <h2>Your store is back</h2>
    <p>The storefront of <strong>${store}</strong> is open to shoppers again and takes orders.</p>
    <p><a href="${link}">Open billing</a></p>`;
  return null;
}

const reviewSubject = (d: SubscriptionBillingNoticeData, lang: 'en' | 'ar'): string | null =>
  d.kind === 'payment_confirmed'
    ? lang === 'ar'
      ? `${d.storeName}: تم تأكيد دفعتك`
      : `${d.storeName}: your payment is confirmed`
    : d.kind === 'payment_rejected'
      ? lang === 'ar'
        ? `${d.storeName}: لم نقبل إيصال التحويل`
        : `${d.storeName}: we could not accept your transfer receipt`
      : d.kind === 'store_restored'
        ? lang === 'ar'
          ? `${d.storeName}: متجرك رجع يشتغل`
          : `${d.storeName}: your store is back`
        : null;

/**
 * Merchant notices from the subscription dunning cycle (SP5 task 3): a failed
 * renewal (a retry is scheduled) and the final downgrade to the free plan.
 * The store and its data are kept — only the paid limits stop applying.
 */
export const subscriptionBillingTemplate = {
  subject: {
    en: (d: SubscriptionBillingNoticeData) =>
      reviewSubject(d, 'en') ??
      (d.kind === 'payment_due'
        ? `${d.storeName}: your ${d.planName} payment is due ${d.daysLeft === 0 ? 'today' : `in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}`}`
        : d.kind === 'grace_started'
          ? `${d.storeName}: your payment is overdue, the store pauses on ${d.suspendOn}`
          : d.kind === 'grace_ending'
            ? `${d.storeName}: your store pauses tomorrow unless you pay`
            : d.kind === 'store_suspended'
              ? `${d.storeName}: your store is paused until payment`
              : d.kind === 'payment_failed'
                ? `${d.storeName}: we could not renew your ${d.planName} plan`
                : `${d.storeName}: new orders are paused`),
    ar: (d: SubscriptionBillingNoticeData) =>
      reviewSubject(d, 'ar') ??
      (d.kind === 'payment_due'
        ? `${d.storeName}: ${d.daysLeft === 0 ? 'دفعة باقة ' + d.planName + ' مستحقة اليوم' : 'دفعة باقة ' + d.planName + ' مستحقة خلال ' + d.daysLeft + ' يوم'}`
        : d.kind === 'grace_started'
          ? `${d.storeName}: دفعتك متأخرة، والمتجر هيتوقف في ${d.suspendOn}`
          : d.kind === 'grace_ending'
            ? `${d.storeName}: متجرك هيتوقف بكرة لو الدفعة ما اتسجلتش`
            : d.kind === 'store_suspended'
              ? `${d.storeName}: تم إيقاف متجرك مؤقتًا لحين الدفع`
              : d.kind === 'payment_failed'
                ? `${d.storeName}: تعذّر تجديد باقة ${d.planName}`
                : `${d.storeName}: الطلبات الجديدة متوقفة`),
  },
  en: (d: SubscriptionBillingNoticeData) =>
    reviewNotice(d, 'en') ??
    (d.kind === 'payment_due'
      ? `
    <h2>Payment reminder</h2>
    <p>${dueText(d, 'en')}</p>
    ${vatLine(d, 'en')}
    ${instapayBlock(d, 'en')}
    <p><a href="${escapeHtml(d.billingUrl)}">Open billing</a></p>
    ${whatsappLine(d, 'en')}`
      : d.kind === 'grace_started' || d.kind === 'grace_ending'
        ? `
    <h2>${d.kind === 'grace_started' ? 'Your payment is overdue' : 'Your store pauses tomorrow'}</h2>
    <p>The payment for <strong>${escapeHtml(d.storeName)}</strong> has not been recorded. If it is not recorded by
    <strong>${escapeHtml(d.suspendOn ?? '')}</strong>, the storefront will be paused for shoppers. Your admin keeps working and nothing is deleted.</p>
    ${instapayBlock(d, 'en')}
    <p><a href="${escapeHtml(d.billingUrl)}">Pay now</a></p>
    ${whatsappLine(d, 'en')}`
        : d.kind === 'store_suspended'
          ? `
    <h2>Your store is paused</h2>
    <p>We have not received the payment for <strong>${escapeHtml(d.storeName)}</strong>, so its storefront is
    temporarily unavailable to shoppers. Your admin still works and nothing was deleted. The store comes back as soon as the payment is recorded.</p>
    ${instapayBlock(d, 'en')}
    <p><a href="${escapeHtml(d.billingUrl)}">Pay now</a></p>
    ${whatsappLine(d, 'en')}`
          : d.kind === 'payment_failed'
            ? `
    <h2>We could not renew your plan</h2>
    <p>The ${escapeHtml(emailMoney(d.amountMinor, 'EGP', 'en'))} charge for the
    <strong>${escapeHtml(d.planName)}</strong> plan on <strong>${escapeHtml(d.storeName)}</strong> did not go through.
    We will try your card again on ${escapeHtml(d.retryOn ?? 'the next retry date')}. Your store keeps working meanwhile.</p>
    <p><a href="${escapeHtml(d.billingUrl)}">Update your payment method</a></p>`
            : `
    <h2>New orders are paused</h2>
    <p>The subscription of <strong>${escapeHtml(d.storeName)}</strong> ended without a payment, so the store takes no new
    orders. Nothing was deleted — your products, orders and settings are kept.</p>
    <p><a href="${escapeHtml(d.billingUrl)}">Choose a plan and pay to bring it back</a></p>`),
  ar: (d: SubscriptionBillingNoticeData) =>
    reviewNotice(d, 'ar') ??
    (d.kind === 'payment_due'
      ? `
    <h2 dir="rtl">تذكير بالدفع</h2>
    <p dir="rtl">${dueText(d, 'ar')}</p>
    ${vatLine(d, 'ar')}
    ${instapayBlock(d, 'ar')}
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">افتح صفحة الفواتير</a></p>
    ${whatsappLine(d, 'ar')}`
      : d.kind === 'grace_started' || d.kind === 'grace_ending'
        ? `
    <h2 dir="rtl">${d.kind === 'grace_started' ? 'دفعتك متأخرة' : 'متجرك هيتوقف بكرة'}</h2>
    <p dir="rtl">دفعة متجر <strong>${escapeHtml(d.storeName)}</strong> لسه ما اتسجلتش. لو ما اتسجلتش قبل
    <strong dir="ltr">${escapeHtml(d.suspendOn ?? '')}</strong> هنوقف واجهة المتجر أمام الزوار. لوحة التحكم هتفضل شغالة ومفيش حاجة هتتحذف.</p>
    ${instapayBlock(d, 'ar')}
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">ادفع الآن</a></p>
    ${whatsappLine(d, 'ar')}`
        : d.kind === 'store_suspended'
          ? `
    <h2 dir="rtl">تم إيقاف متجرك مؤقتًا</h2>
    <p dir="rtl">لم نستلم دفعة متجر <strong>${escapeHtml(d.storeName)}</strong>، لذلك واجهة المتجر غير متاحة للزوار مؤقتًا.
    لوحة التحكم تعمل ولم يُحذف أي شيء، ويعود المتجر فور تسجيل الدفعة.</p>
    ${instapayBlock(d, 'ar')}
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">ادفع الآن</a></p>
    ${whatsappLine(d, 'ar')}`
          : d.kind === 'payment_failed'
            ? `
    <h2 dir="rtl">تعذّر تجديد باقتك</h2>
    <p dir="rtl">لم تتم عملية الدفع بمبلغ ${escapeHtml(emailMoney(d.amountMinor, 'EGP', 'ar'))} لباقة
    <strong>${escapeHtml(d.planName)}</strong> الخاصة بمتجر <strong>${escapeHtml(d.storeName)}</strong>.
    سنحاول خصم المبلغ من بطاقتك مرة أخرى في ${escapeHtml(d.retryOn ?? 'موعد المحاولة التالية')}. يستمر متجرك في العمل خلال ذلك.</p>
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">حدّث وسيلة الدفع</a></p>`
            : `
    <h2 dir="rtl">الطلبات الجديدة متوقفة</h2>
    <p dir="rtl">اشتراك متجر <strong>${escapeHtml(d.storeName)}</strong> انتهى من غير دفع، فالمتجر مش هيستقبل طلبات جديدة.
    لم يُحذف أي شيء — منتجاتك وطلباتك وإعداداتك محفوظة.</p>
    <p dir="rtl"><a href="${escapeHtml(d.billingUrl)}">اختار باقة وادفع عشان المتجر يرجع</a></p>`),
};
