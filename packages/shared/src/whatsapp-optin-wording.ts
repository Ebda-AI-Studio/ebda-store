/**
 * The exact words shown beside the checkout's WhatsApp marketing opt-in tick (WA-CONSENT-1), one source
 * for the storefront and for the proof sent to Ebda Chat (`customer.consent_changed.wording`,
 * contract v1.5). The wording a buyer ticked is the wording we can show later, so it lives in ONE place:
 * change a sentence here and the proof changes with it (bump nothing else, but know that rows ticked
 * under the old words are re-announced with the new ones until a per-row wording is stored).
 */
export type OptInLocale = 'ar' | 'en';

export const WHATSAPP_OPTIN_LABEL: Record<OptInLocale, string> = {
  en: 'Send me offers and reminders on WhatsApp',
  ar: 'ابعتلي عروض وتذكيرات على واتساب',
};

export const WHATSAPP_OPTIN_NOTE: Record<OptInLocale, string> = {
  en: 'Marketing messages only. Order updates are separate. You can stop them anytime.',
  ar: 'رسائل تسويقية بس، وتحديثات الطلب منفصلة. وتقدر توقفها في أي وقت.',
};

/** The sentence(s) the buyer saw next to the tick, in the locale shown: label then note. */
export function whatsappOptInWording(locale: OptInLocale): string {
  return `${WHATSAPP_OPTIN_LABEL[locale]} ${WHATSAPP_OPTIN_NOTE[locale]}`;
}
