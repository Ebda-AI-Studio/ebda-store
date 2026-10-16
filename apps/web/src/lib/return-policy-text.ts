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
 * "14 days" / "١٤ يوم" after a preposition (every caller says "خلال …"), through
 * the one plural helper (Egyptian forms: "خلال يومين", Ruling FU46-Y02a).
 * `localize` puts the number in the store's digits (review M8: the PDP trust
 * line and /returns must agree); default Western.
 */
export function daysPhrase(
  n: number,
  lang: PolicyLang,
  localize: (v: number) => string = String
): string {
  return countText(lang, n, DAYS, localize(n));
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
          body: `نتمنى تكون راضي تمامًا عن مشترياتك. لو الطلب مش مناسبك، تقدر ترجعه خلال ${daysPhrase(n, 'ar', localize)} من تاريخ التوصيل.`,
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
          body: 'المتجر ده مش بيقبل الإرجاع. لو وصلك منتج تالف أو مش زي الوصف، كلّم المتجر وهيساعدك.',
        }
      : {
          title: 'Returns Not Accepted',
          body: 'This store does not accept returns. If your item arrived damaged or not as described, please contact the store and we will help.',
        };
  }
  return lang === 'ar'
    ? {
        title: 'سياسة الإرجاع',
        body: 'كلّم المتجر عشان تعرف مدة الإرجاع المتاحة لطلبك قبل ما تطلب.',
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
      ? `سياسة الإرجاع عندنا بتسمح بالإرجاع خلال ${daysPhrase(n, 'ar', localize)} من التوصيل. شوف صفحة المرتجعات عشان تعرف كل التفاصيل عن الشروط والخطوات.`
      : `Our return policy allows returns within ${daysPhrase(n, 'en')} of delivery. Please refer to our Returns page for complete details on eligibility and process.`;
  }
  if (kind === 'none') {
    return lang === 'ar'
      ? 'المتجر ده مش بيقبل الإرجاع. شوف صفحة المرتجعات عشان تعرف التفاصيل.'
      : 'This store does not accept returns. Please refer to our Returns page for details.';
  }
  return lang === 'ar'
    ? 'مدة الإرجاع بيحددها المتجر. شوف صفحة المرتجعات أو كلّمنا عشان تعرف كل التفاصيل عن الشروط والخطوات.'
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
      ? `بنقبل الإرجاع خلال ${daysPhrase(n, 'ar', localize)} للمنتجات اللي ما اتستعملتش وفي علبتها الأصلية. شوف صفحة المرتجعات لتفاصيل أكتر.`
      : `We offer a ${n}-day return policy for unused items in original packaging. Please visit our Returns page for more details.`;
  }
  if (kind === 'none') {
    return lang === 'ar'
      ? 'المتجر ده مش بيقبل الإرجاع. شوف صفحة المرتجعات لتفاصيل أكتر.'
      : 'This store does not accept returns. Please visit our Returns page for more details.';
  }
  return lang === 'ar'
    ? 'مدة الإرجاع بيحددها المتجر. شوف صفحة المرتجعات أو كلّمنا لتفاصيل أكتر.'
    : 'The return period is set by the store. Please visit our Returns page or contact us for more details.';
}
