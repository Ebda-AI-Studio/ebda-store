/**
 * Ruling COOKIE-UI-1: ONE cookie bar for the whole family (store, marketing, shells).
 *
 * The three surfaces render it with different tech (React in the store, a vanilla DOM bar in the marketing
 * tracker), so this file is the single source of the parts that must never drift: the words, the order of the
 * controls and the mobile height budget. Behaviour (what accept / reject write, whether the page reloads) stays
 * with each surface's own consent code and is not decided here.
 *
 * Shape on a phone: one compact bar, at most CONSENT_BAR_MAX_VIEWPORT_SHARE of the viewport tall, sitting above
 * any tab bar. Reject and accept are equals (same size, same fill, one tap each; a regulator reads a
 * brand-coloured accept next to an outline reject as a dark pattern). Customize is a quiet link, not a third button.
 */
export const CONSENT_BAR_MAX_VIEWPORT_SHARE = 0.12;

export const CONSENT_UI = {
  ar: {
    label: 'إعدادات ملفات الارتباط',
    text: 'نستخدم ملفات أساسية لتشغيل الموقع، وملفات اختيارية لقياس الإعلانات.',
    reject: 'رفض الكل',
    accept: 'قبول',
    customize: 'تخصيص',
    more: 'اعرف المزيد',
    save: 'حفظ اختياراتي',
    analytics: 'قياس الزيارات',
    marketing: 'قياس الإعلانات',
  },
  en: {
    label: 'Cookie settings',
    text: 'We use essential cookies to run the site, and optional ones to measure ads.',
    reject: 'Reject all',
    accept: 'Accept',
    customize: 'Customize',
    more: 'Learn more',
    save: 'Save my choices',
    analytics: 'Visit measurement',
    marketing: 'Ad measurement',
  },
} as const;

export type ConsentUiLang = keyof typeof CONSENT_UI;
