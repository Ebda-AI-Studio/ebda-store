import { escapeHtml } from './_util';
import type { OrderEmailData } from '../email.service';

export const paymentSuccessTemplate = {
  subject: {
    en: (d: OrderEmailData, _storeName: string) => `Payment Received - Order #${d.orderNumber}`,
    ar: (d: OrderEmailData, _storeName: string) => `تم استلام الدفعة - طلب رقم ${d.orderNumber}`,
  },

  en: (d: OrderEmailData, _storeName: string) => `
    <h2>Payment Received</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>We've successfully processed your payment of <strong>${(d.total / 1000).toFixed(3)} KWD</strong> for order #${escapeHtml(d.orderNumber)}.</p>
    <p>Your order is now being prepared for shipment.</p>
    <p>Thank you for shopping with us!</p>
  `,

  ar: (d: OrderEmailData, _storeName: string) => `
    <h2>تم استلام الدفعة</h2>
    <p>مرحباً ${escapeHtml(d.customerName)}،</p>
    <p>تمت معالجة دفعتك بنجاح بمبلغ <strong>${(d.total / 1000).toFixed(3)} د.ك</strong> للطلب رقم ${escapeHtml(d.orderNumber)}.</p>
    <p>يجري الآن تجهيز طلبك للشحن.</p>
    <p>شكراً لتسوقك معنا!</p>
  `,
};
