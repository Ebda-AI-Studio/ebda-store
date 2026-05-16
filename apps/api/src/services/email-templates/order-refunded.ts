import { escapeHtml } from './_util';
import type { OrderRefundEmailData } from '../email.service';

export const orderRefundedTemplate = {
  subject: {
    en: (d: OrderRefundEmailData) => `Refund Issued — Order #${d.orderNumber}`,
    ar: (d: OrderRefundEmailData) => `تم استرداد المبلغ — طلب رقم ${d.orderNumber}`,
  },

  en: (d: OrderRefundEmailData) => `
    <h2>Your refund has been issued</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>
      We've processed a refund of <strong>${(d.refundAmount / 1000).toFixed(3)} KWD</strong>
      for order <strong>#${escapeHtml(d.orderNumber)}</strong>. The amount will appear on
      your original payment method within 5–10 business days, depending on your bank.
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
          <td style="text-align: right;">${(d.orderTotal / 1000).toFixed(3)} KWD</td>
        </tr>
        <tr class="total-row">
          <td>Refunded</td>
          <td style="text-align: right;">-${(d.refundAmount / 1000).toFixed(3)} KWD</td>
        </tr>
      </tbody>
    </table>

    <p style="margin-top: 1.5rem;">If you have any questions, just reply to this email.</p>
  `,

  ar: (d: OrderRefundEmailData) => `
    <h2>تم استرداد مبلغ طلبك</h2>
    <p>مرحباً ${escapeHtml(d.customerName)}،</p>
    <p>
      أصدرنا استرداداً بقيمة <strong>${(d.refundAmount / 1000).toFixed(3)} د.ك</strong>
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
          <td style="text-align: right;">${(d.orderTotal / 1000).toFixed(3)} د.ك</td>
        </tr>
        <tr class="total-row">
          <td>المبلغ المسترد</td>
          <td style="text-align: right;">-${(d.refundAmount / 1000).toFixed(3)} د.ك</td>
        </tr>
      </tbody>
    </table>

    <p style="margin-top: 1.5rem;">لأي استفسار، يكفي الرد على هذه الرسالة.</p>
  `,
};
