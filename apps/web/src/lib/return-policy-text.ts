/**
 * Storefront return-policy copy driven by the store's `returnWindowDays`
 * (sense audit 1, finding 8): a positive number is the published window,
 * `0` means returns are not accepted, and null/undefined means the merchant
 * declared nothing (so no number is printed).
 */
import { countText, DAYS } from './plural';
export type PolicyLang = 'ar' | 'en';

export type ReturnPolicyKind = 'window' | 'none' | 'undeclared';

export function returnPolicyKind(days: number | null | undefined): ReturnPolicyKind {
  if (days === null || days === undefined || !Number.isFinite(days)) return 'undeclared';
  return days <= 0 ? 'none' : 'window';
}

/**
 * "14 days" / "١٤ يومًا" after a preposition (every caller says "خلال …" /
 * "لمدة …"), through the one plural helper in the oblique case ("خلال يومين").
 * `localize` puts the number in the store's digits (review M8: the PDP trust
 * line and /returns must agree); default Western.
 */
export function daysPhrase(
  n: number,
  lang: PolicyLang,
  localize: (v: number) => string = String
): string {
  return countText(lang, n, DAYS, localize(n), 'oblique');
}

export interface ReturnPolicyCopy {
  title: string;
  body: string;
}

export function returnPolicyCopy(
  days: number | null | undefined,
  lang: PolicyLang,
  localize: (v: number) => string = String
): ReturnPolicyCopy {
  const kind = returnPolicyKind(days);
  if (kind === 'window') {
    const n = days as number;
    return lang === 'ar'
      ? {
          title: `سياسة الإرجاع خلال ${daysPhrase(n, 'ar', localize)}`,
          body: `نتمنى أن تكون راضياً تماماً عن مشترياتك. إذا لم يناسبك الطلب، يمكنك إرجاعه خلال ${daysPhrase(n, 'ar', localize)} من تاريخ التوصيل.`,
        }
      : {
          title: `${n}-Day Return Policy`,
          body: `We want you to be completely satisfied with your purchase. If you're not happy with your order, you can request a return within ${daysPhrase(n, 'en')} of delivery.`,
        };
  }
  if (kind === 'none') {
    return lang === 'ar'
      ? {
          title: 'الإرجاع غير متاح',
          body: 'هذا المتجر لا يقبل طلبات الإرجاع. إذا وصلك منتج تالف أو غير مطابق، تواصل مع المتجر وسنساعدك.',
        }
      : {
          title: 'Returns Not Accepted',
          body: 'This store does not accept returns. If your item arrived damaged or not as described, please contact the store and we will help.',
        };
  }
  return lang === 'ar'
    ? {
        title: 'سياسة الإرجاع',
        body: 'تواصل مع المتجر لمعرفة مدة الإرجاع المتاحة لطلبك قبل تقديم الطلب.',
      }
    : {
        title: 'Return Policy',
        body: 'Please contact the store to confirm the return period that applies to your order before requesting a return.',
      };
}

/** One sentence for the Terms page, §Returns and Refunds. */
export function termsReturnSentence(
  days: number | null | undefined,
  lang: PolicyLang,
  localize: (v: number) => string = String
): string {
  const kind = returnPolicyKind(days);
  if (kind === 'window') {
    const n = days as number;
    return lang === 'ar'
      ? `تسمح سياسة الإرجاع لدينا بالإرجاع خلال ${daysPhrase(n, 'ar', localize)} من التوصيل. يرجى الرجوع إلى صفحة المرتجعات لمعرفة التفاصيل الكاملة حول الأهلية والإجراءات.`
      : `Our return policy allows returns within ${daysPhrase(n, 'en')} of delivery. Please refer to our Returns page for complete details on eligibility and process.`;
  }
  if (kind === 'none') {
    return lang === 'ar'
      ? 'لا يقبل هذا المتجر طلبات الإرجاع. يرجى الرجوع إلى صفحة المرتجعات لمعرفة التفاصيل.'
      : 'This store does not accept returns. Please refer to our Returns page for details.';
  }
  return lang === 'ar'
    ? 'تختلف مدة الإرجاع حسب المتجر. يرجى الرجوع إلى صفحة المرتجعات أو التواصل معنا لمعرفة التفاصيل الكاملة حول الأهلية والإجراءات.'
    : 'The return period is set by the store. Please refer to our Returns page or contact us for complete details on eligibility and process.';
}

/** Generic-FAQ answer for "What is your return policy?" (no number unless the store declared one). */
export function faqReturnAnswer(
  days: number | null | undefined,
  lang: PolicyLang,
  localize: (v: number) => string = String
): string {
  const kind = returnPolicyKind(days);
  if (kind === 'window') {
    const n = days as number;
    return lang === 'ar'
      ? `نقدم سياسة إرجاع لمدة ${daysPhrase(n, 'ar', localize)} للعناصر غير المستخدمة في عبوتها الأصلية. يرجى زيارة صفحة المرتجعات لمزيد من التفاصيل.`
      : `We offer a ${n}-day return policy for unused items in original packaging. Please visit our Returns page for more details.`;
  }
  if (kind === 'none') {
    return lang === 'ar'
      ? 'هذا المتجر لا يقبل طلبات الإرجاع. يرجى زيارة صفحة المرتجعات لمزيد من التفاصيل.'
      : 'This store does not accept returns. Please visit our Returns page for more details.';
  }
  return lang === 'ar'
    ? 'تختلف مدة الإرجاع حسب المتجر. يرجى زيارة صفحة المرتجعات أو التواصل معنا لمزيد من التفاصيل.'
    : 'The return period is set by the store. Please visit our Returns page or contact us for more details.';
}
