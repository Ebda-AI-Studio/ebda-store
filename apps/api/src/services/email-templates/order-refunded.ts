import { escapeHtml, emailMoney } from './_util';
import type { OrderRefundEmailData } from '../email.service';

export const orderRefundedTemplate = {
  subject: {
    en: (d: OrderRefundEmailData) => `Refund Requested — Order #${d.orderNumber}`,
    ar: (d: OrderRefundEmailData) => `تم طلب الاسترداد — طلب رقم ${d.orderNumber}`,
  },

  en: (d: OrderRefundEmailData) => `
    <h2>Your refund has been requested</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>
      A refund of <strong>${emailMoney(d.refundAmount, d.currency, 'en')}</strong>
      for order <strong>#${escapeHtml(d.orderNumber)}</strong> has been submitted to the
      payment provider. The amount will appear on your original payment method within
      1–3 business days, depending on the provider and your bank.
    </p>

    ${
      d.reason
        ? `<div class="address-box"><strong>Reason</strong><br>${escapeHtml(d.reason)}</div>`
        : ''
    }

    <table class="order-table">
      <tbody>
        <tr>
          <td>Order Total</td>
          <td style="text-align: right;">${emailMoney(d.orderTotal, d.currency, 'en')}</td>
        </tr>
        <tr class="total-row">
          <td>Refunded</td>
          <td style="text-align: right;">-${emailMoney(d.refundAmount, d.currency, 'en')}</td>
        </tr>
      </tbody>
    </table>

    <p style="margin-top: 1.5rem;">If you have any questions, just reply to this email.</p>
  `,

  ar: (d: OrderRefundEmailData) => `
    <h2>تم استرداد مبلغ طلبك</h2>
    <p>مرحباً ${escapeHtml(d.customerName)}،</p>
    <p>
      أصدرنا استرداداً بقيمة <strong>${emailMoney(d.refundAmount, d.currency, 'ar')}</strong>
      للطلب رقم <strong>${escapeHtml(d.orderNumber)}</strong>. سيظهر المبلغ في طريقة الدفع
      الأصلية خلال 5 إلى 10 أيام عمل وفقاً لبنكك.
    </p>

    ${
      d.reason
        ? `<div class="address-box"><strong>السبب</strong><br>${escapeHtml(d.reason)}</div>`
        : ''
    }

    <table class="order-table">
      <tbody>
        <tr>
          <td>إجمالي الطلب</td>
          <td style="text-align: right;">${emailMoney(d.orderTotal, d.currency, 'ar')}</td>
        </tr>
        <tr class="total-row">
          <td>المبلغ المسترد</td>
          <td style="text-align: right;">-${emailMoney(d.refundAmount, d.currency, 'ar')}</td>
        </tr>
      </tbody>
    </table>

    <p style="margin-top: 1.5rem;">لأي استفسار، يكفي الرد على هذه الرسالة.</p>
  `,
};
