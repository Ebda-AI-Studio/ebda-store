/**
 * Coupon refusal copy, chosen by the API's error CODE (a11y re-audit P1-N1: the API's English
 * `message` showed on the Arabic checkout). Full sentences in the store's Egyptian voice
 * (Ahmad 2026-10-16); an unknown code reads as "not valid".
 */
type T = (en: string, ar: string) => string;

export function couponErrorCopy(code: string | undefined, t: T): string {
  switch (code) {
    case 'COUPON_EXPIRED':
      return t('This code has expired.', 'الكود ده انتهى.');
    case 'COUPON_NOT_STARTED':
      return t("This code isn't active yet.", 'الكود ده لسه مبدأش.');
    case 'COUPON_LIMIT_REACHED':
      return t('This code has been used up.', 'الكود ده خلص استخدامه.');
    case 'COUPON_NOT_ELIGIBLE':
      return t(
        "This code doesn't apply to the items in your cart.",
        'الكود ده مش على المنتجات اللي في سلتك.'
      );
    case 'COUPON_NEEDS_CONTACT':
      return t(
        'Add your phone number or email to use this code (one use per customer).',
        'ضيف رقم موبايلك أو إيميلك عشان تستخدم الكود ده (مرة واحدة لكل عميل).'
      );
    case 'MIN_ORDER_NOT_MET':
      return t("Your order is below this code's minimum.", 'طلبك أقل من الحد الأدنى للكود ده.');
    default:
      return t("This code isn't valid.", 'الكود ده مش صالح.');
  }
}
