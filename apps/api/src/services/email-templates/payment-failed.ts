import { escapeHtml } from './_util';

export interface PaymentFailedData {
  customerEmail: string;
  customerName: string;
  orderNumber: string;
  reason?: string;
}

export const paymentFailedTemplate = {
  subject: {
    en: (d: PaymentFailedData, _storeName: string) => `Payment Failed - Order #${d.orderNumber}`,
    ar: (d: PaymentFailedData, _storeName: string) => `فشلت عملية الدفع - طلب رقم ${d.orderNumber}`,
  },

  en: (d: PaymentFailedData, _storeName: string, webUrl: string) => `
    <h2>Payment Failed</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>Unfortunately, we were unable to process your payment for order #${escapeHtml(d.orderNumber)}.</p>
    ${d.reason ? `<p><strong>Reason:</strong> ${escapeHtml(d.reason)}</p>` : ''}
    <p>Please update your payment information or try a different payment method.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(webUrl)}/checkout" class="button">Retry Payment</a>
    </p>
  `,

  ar: (d: PaymentFailedData, _storeName: string, webUrl: string) => `
    <h2>فشلت عملية الدفع</h2>
    <p>مرحباً ${escapeHtml(d.customerName)}،</p>
    <p>للأسف، تعذّر علينا معالجة دفعتك للطلب رقم ${escapeHtml(d.orderNumber)}.</p>
    ${d.reason ? `<p><strong>السبب:</strong> ${escapeHtml(d.reason)}</p>` : ''}
    <p>حاول مرة أخرى أو تواصل مع الدعم.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(webUrl)}/checkout" class="button">إعادة المحاولة</a>
    </p>
  `,
};
