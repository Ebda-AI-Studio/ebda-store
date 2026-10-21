import { escapeHtml } from './_util';

export interface OrderShippedData {
  customerEmail: string;
  customerName: string;
  orderNumber: string;
  trackingNumber?: string;
  trackingUrl?: string;
  carrier?: string;
}

export const orderShippedTemplate = {
  subject: {
    en: (d: OrderShippedData, _storeName: string) => `Your Order Has Shipped - #${d.orderNumber}`,
    ar: (d: OrderShippedData, _storeName: string) => `طلبك اتشحن - رقم ${d.orderNumber}`,
  },

  en: (d: OrderShippedData, _storeName: string) => `
    <h2>Your Order Has Shipped!</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>Great news! Your order #${escapeHtml(d.orderNumber)} is on its way.</p>
    ${d.carrier ? `<p><strong>Carrier:</strong> ${escapeHtml(d.carrier)}</p>` : ''}
    ${d.trackingNumber ? `<p><strong>Tracking number:</strong> ${escapeHtml(d.trackingNumber)}</p>` : ''}
    ${
      d.trackingUrl
        ? `<p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.trackingUrl)}" class="button">Track Order</a>
    </p>`
        : ''
    }
    <p>Thank you for shopping with us!</p>
  `,

  ar: (d: OrderShippedData, _storeName: string) => `
    <h2>طلبك اتشحن!</h2>
    <p>أهلاً ${escapeHtml(d.customerName)}،</p>
    <p>خبر حلو! طلبك رقم ${escapeHtml(d.orderNumber)} في الطريق ليك.</p>
    ${d.carrier ? `<p><strong>شركة الشحن:</strong> ${escapeHtml(d.carrier)}</p>` : ''}
    ${d.trackingNumber ? `<p><strong>رقم التتبع:</strong> ${escapeHtml(d.trackingNumber)}</p>` : ''}
    ${
      d.trackingUrl
        ? `<p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.trackingUrl)}" class="button">تتبع الطلب</a>
    </p>`
        : ''
    }
    <p>شكراً إنك اشتريت من عندنا!</p>
  `,
};
