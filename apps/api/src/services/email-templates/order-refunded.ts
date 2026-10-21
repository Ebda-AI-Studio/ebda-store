import { escapeHtml, emailMoney } from './_util';
import type { OrderRefundEmailData } from '../email.service';

export const orderRefundedTemplate = {
  subject: {
    en: (d: OrderRefundEmailData) => `Refund Requested — Order #${d.orderNumber}`,
    ar: (d: OrderRefundEmailData) => `بنرجّعلك فلوسك — طلب رقم ${d.orderNumber}`,
  },

  en: (d: OrderRefundEmailData) => `
    <h2>Your refund has been requested</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>
      A refund of <strong>${emailMoney(d.refundAmount, d.currency, 'en')}</strong>
      for order <strong>#${escapeHtml(d.orderNumber)}</strong> has been submitted to the
      payment provider. The amount will appear on your original payment method within
      5–10 business days, depending on the provider and your bank.
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
          <td style="text-align: end;">${emailMoney(d.orderTotal, d.currency, 'en')}</td>
        </tr>
        <tr class="total-row">
          <td>Refunded</td>
          <td style="text-align: end;">-${emailMoney(d.refundAmount, d.currency, 'en')}</td>
        </tr>
      </tbody>
    </table>

    <p style="margin-top: 1.5rem;">If you have any questions, just reply to this email.</p>
  `,

  ar: (d: OrderRefundEmailData) => `
    <h2>بنرجّعلك مبلغ طلبك</h2>
    <p>أهلاً ${escapeHtml(d.customerName)}،</p>
    <p>
      بعتنا طلب استرداد بقيمة <strong>${emailMoney(d.refundAmount, d.currency, 'ar')}</strong>
      للطلب رقم <strong>${escapeHtml(d.orderNumber)}</strong>. المبلغ هيظهر في طريقة الدفع
      الأصلية خلال 5–10 أيام عمل حسب بنكك.
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
          <td style="text-align: end;">${emailMoney(d.orderTotal, d.currency, 'ar')}</td>
        </tr>
        <tr class="total-row">
          <td>المبلغ المسترد</td>
          <td style="text-align: end;">-${emailMoney(d.refundAmount, d.currency, 'ar')}</td>
        </tr>
      </tbody>
    </table>

    <p style="margin-top: 1.5rem;">لو عندك أي سؤال، رُد على الرسالة دي.</p>
  `,
};
