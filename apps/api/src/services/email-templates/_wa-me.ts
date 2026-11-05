import {
  buildCodConfirmationMessage,
  buildOrderQuestionMessage,
  resolveWaMeVisibility,
  waMeLink,
  type WaMeToggles,
} from '@ebda/shared';
import { escapeHtml } from './_util';
import type { OrderEmailData } from '../email.service';

/**
 * Free-tier WhatsApp (`wa.me` click-to-chat) for order emails. Pure string
 * building — no WhatsApp API, no network. The email carries a link the
 * CUSTOMER taps; nothing is sent on their behalf.
 */
export type OrderEmailWaMe = NonNullable<OrderEmailData['waMe']>;

/**
 * The wa.me link for an order email, or `undefined` when the store has no
 * valid WhatsApp number / the relevant toggle is off. A COD order gets the
 * confirmation prompt; everything else gets the "ask about this order" link.
 */
export function buildOrderEmailWaMe(
  d: OrderEmailData,
  store: { name: string; nameAr?: string | null; whatsapp?: string | null; theme?: unknown },
  locale: 'en' | 'ar'
): OrderEmailWaMe | undefined {
  const toggles = (
    store.theme && typeof store.theme === 'object' ? store.theme : {}
  ) as WaMeToggles;
  const vis = resolveWaMeVisibility(store.whatsapp, toggles);
  const storeName = locale === 'ar' && store.nameAr ? store.nameAr : store.name;
  if (d.isCod && vis.codConfirm) {
    const url = waMeLink(
      store.whatsapp,
      buildCodConfirmationMessage({
        locale,
        orderNumber: d.orderNumber,
        items: d.items,
        totalMinor: d.total,
        address: d.shippingAddress,
        deliveryLine: d.deliveryLine,
        storeName,
      })
    );
    return url ? { url, kind: 'cod_confirm' } : undefined;
  }
  if (vis.orderQuestion) {
    const url = waMeLink(
      store.whatsapp,
      buildOrderQuestionMessage({ locale, orderNumber: d.orderNumber, storeName })
    );
    return url ? { url, kind: 'order_question' } : undefined;
  }
  return undefined;
}

const COPY = {
  en: {
    cod_confirm: {
      text: 'Cash on delivery: please confirm your order on WhatsApp.',
      cta: 'Confirm on WhatsApp',
    },
    order_question: { text: 'Questions about your order?', cta: 'Ask on WhatsApp' },
  },
  ar: {
    cod_confirm: {
      text: 'الدفع عند الاستلام: برجاء تأكيد طلبك على واتساب.',
      cta: 'أكّد على واتساب',
    },
    order_question: { text: 'عندك سؤال عن طلبك؟', cta: 'اسأل على واتساب' },
  },
} as const;

/** The email block: a sentence plus a `.button` link (inlined by the layout). */
export function waMeEmailBlock(waMe: OrderEmailWaMe | undefined, locale: 'en' | 'ar'): string {
  if (!waMe) return '';
  const c = COPY[locale][waMe.kind];
  return `
    <p>${c.text}</p>
    <p><a href="${escapeHtml(waMe.url)}" class="button">${c.cta}</a></p>`;
}
