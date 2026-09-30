import { escapeHtml } from './_util';

/**
 * The customer's notice when an order is cancelled before any refund has
 * moved (owner decision 2026-10-01, issue 1948; ruling R2-5a). The "Refund
 * issued" email is held back until a refund actually settles, so this is the
 * notice at the cancel itself. Accurate by case:
 *
 *   - `charged: false` — the payment was never captured (auth-only, voided,
 *     unpaid, or cash on delivery): "You were not charged."
 *   - `charged: true` — the payment was captured and its refund is pending:
 *     "Your refund is being processed."
 */
export interface OrderCancelledEmailData {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  /** The payment was captured (a refund is owed and pending). */
  charged: boolean;
}

export const orderCancelledNotChargedTemplate = {
  subject: {
    en: (d: OrderCancelledEmailData) => `Order #${d.orderNumber} cancelled`,
    ar: (d: OrderCancelledEmailData) => `تم إلغاء الطلب رقم ${d.orderNumber}`,
  },

  en: (d: OrderCancelledEmailData) => `
    <h2>Your order was cancelled</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>
      Your order <strong>#${escapeHtml(d.orderNumber)}</strong> was cancelled.
      ${d.charged ? 'Your refund is being processed.' : 'You were not charged.'}
    </p>
    <p style="margin-top: 1.5rem;">If you have any questions, just reply to this email.</p>
  `,

  ar: (d: OrderCancelledEmailData) => `
    <h2>تم إلغاء طلبك</h2>
    <p>مرحباً ${escapeHtml(d.customerName)}،</p>
    <p>
      تم إلغاء طلبك رقم <strong>${escapeHtml(d.orderNumber)}</strong>.
      ${d.charged ? 'جارٍ معالجة استرداد المبلغ.' : 'لم يتم خصم أي مبلغ منك.'}
    </p>
    <p style="margin-top: 1.5rem;">لأي استفسار، يكفي الرد على هذه الرسالة.</p>
  `,
};
