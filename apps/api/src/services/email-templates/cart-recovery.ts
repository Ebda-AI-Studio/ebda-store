import { escapeHtml, emailMoney } from './_util';

/**
 * Abandoned-cart recovery email body (one reminder per cart). The branded shell,
 * the sender and the unsubscribe headers are added by the caller
 * (`cart-recovery-email.service`); this is just the content + the consent footer.
 *
 * Arabic is Egyptian (docs/ebda/templates/quality-bar.md section 2): "إنت", joined
 * negation, never "حضرتك"; the button is a short neutral label.
 */
export interface CartRecoveryItem {
  productName: string;
  price: number;
  quantity: number;
}

export interface CartRecoveryData {
  storeName: string;
  items: CartRecoveryItem[];
  total: number;
  cartUrl: string;
  unsubscribeUrl: string;
}

const MAX_LISTED = 5;

function rows(items: CartRecoveryItem[], locale: 'en' | 'ar'): string {
  return items
    .slice(0, MAX_LISTED)
    .map(
      i =>
        `<tr><td style="padding:6px 0;">${escapeHtml(i.productName)} &times; ${i.quantity}</td>` +
        `<td style="padding:6px 0;text-align:${locale === 'ar' ? 'left' : 'right'};white-space:nowrap;">${escapeHtml(emailMoney(i.price * i.quantity, null, locale))}</td></tr>`
    )
    .join('');
}

export const cartRecoveryTemplate = {
  subject: {
    en: (d: CartRecoveryData) => `You left something in your cart at ${d.storeName}`,
    ar: (d: CartRecoveryData) => `سلتك لسه مستنياك في ${d.storeName}`,
  },

  en: (d: CartRecoveryData) => {
    const more = d.items.length - MAX_LISTED;
    return `
      <h2>Your cart is still waiting</h2>
      <p>You left a few things in your cart at ${escapeHtml(d.storeName)}. They are saved for you.</p>
      <table role="presentation" width="100%" style="border-collapse:collapse;margin:12px 0;">${rows(d.items, 'en')}</table>
      ${more > 0 ? `<p>and ${more} more</p>` : ''}
      <p><strong>Cart total: ${escapeHtml(emailMoney(d.total, null, 'en'))}</strong></p>
      <p style="margin:24px 0;"><a href="${escapeHtml(d.cartUrl)}" class="button">Complete your order</a></p>
      <p style="color:#94a3b8;font-size:12px;">If you already ordered, ignore this email. This is a one-time reminder.</p>
      <p style="margin-top:28px;font-size:12px;color:#94a3b8;text-align:center;">You are receiving this because you subscribed to ${escapeHtml(d.storeName)}'s newsletter. <a href="${escapeHtml(d.unsubscribeUrl)}" style="color:#94a3b8;">Unsubscribe</a></p>`;
  },

  ar: (d: CartRecoveryData) => {
    const more = d.items.length - MAX_LISTED;
    return `
      <h2>سلتك لسه مستنياك</h2>
      <p>إنت سيبت كام حاجة في سلتك على ${escapeHtml(d.storeName)}. لسه محفوظة ليك.</p>
      <table role="presentation" width="100%" style="border-collapse:collapse;margin:12px 0;">${rows(d.items, 'ar')}</table>
      ${more > 0 ? `<p>و${more} كمان</p>` : ''}
      <p><strong>إجمالي السلة: ${escapeHtml(emailMoney(d.total, null, 'ar'))}</strong></p>
      <p style="margin:24px 0;"><a href="${escapeHtml(d.cartUrl)}" class="button">كمّل طلبك</a></p>
      <p style="color:#94a3b8;font-size:12px;">لو طلبت خلاص، تجاهل الرسالة دي. دي رسالة تذكير مرة واحدة بس.</p>
      <p style="margin-top:28px;font-size:12px;color:#94a3b8;text-align:center;">وصلتك الرسالة دي عشان إنت مشترك في نشرة ${escapeHtml(d.storeName)} البريدية. <a href="${escapeHtml(d.unsubscribeUrl)}" style="color:#94a3b8;">إلغاء الاشتراك</a></p>`;
  },
};
