import { escapeHtml, emailMoney } from './_util';
import type { OrderEmailData } from '../email.service';

export const paymentSuccessTemplate = {
  subject: {
    en: (d: OrderEmailData, _storeName: string) => `Payment Received - Order #${d.orderNumber}`,
    ar: (d: OrderEmailData, _storeName: string) => `الدفع وصلنا - طلب رقم ${d.orderNumber}`,
  },

  en: (d: OrderEmailData, _storeName: string) => `
    <h2>Payment Received</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>We've successfully processed your payment of <strong>${emailMoney(d.total, d.currency, 'en')}</strong> for order #${escapeHtml(d.orderNumber)}.</p>
    <p>Your order is now being prepared for shipment.</p>
    <p>Thank you for shopping with us!</p>
  `,

  ar: (d: OrderEmailData, _storeName: string) => `
    <h2>الدفع وصلنا</h2>
    <p>أهلاً ${escapeHtml(d.customerName)}،</p>
    <p>استلمنا دفعتك بمبلغ <strong>${emailMoney(d.total, d.currency, 'ar')}</strong> للطلب رقم ${escapeHtml(d.orderNumber)}.</p>
    <p>بنجهّز طلبك للشحن دلوقتي.</p>
    <p>شكراً إنك اشتريت من عندنا!</p>
  `,
};
