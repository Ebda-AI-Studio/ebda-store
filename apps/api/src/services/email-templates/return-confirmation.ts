import { escapeHtml } from './_util';

export interface ReturnConfirmationData {
  email: string;
  customerName: string;
  storeName: string;
  returnNumber: string;
  orderNumber: string;
  type: string;
}

function typeLabel(type: string): string {
  return type === 'exchange' ? 'Exchange' : type === 'refund' ? 'Refund' : 'Return';
}

function typeLabelAr(type: string): string {
  return type === 'exchange' ? 'الاستبدال' : type === 'refund' ? 'الاسترداد' : 'المرتجع';
}

function typeLabelArRequest(type: string): string {
  return type === 'exchange'
    ? 'استلمنا طلب الاستبدال'
    : type === 'refund'
      ? 'استلمنا طلب الاسترداد'
      : 'استلمنا طلب الإرجاع';
}

export const returnConfirmationTemplate = {
  subject: {
    en: (d: ReturnConfirmationData, _storeName: string) =>
      `${typeLabel(d.type)} Request Received - #${d.returnNumber}`,
    ar: (d: ReturnConfirmationData, _storeName: string) =>
      `${typeLabelArRequest(d.type)} - #${d.returnNumber}`,
  },

  en: (d: ReturnConfirmationData, _storeName: string) => {
    const label = typeLabel(d.type);
    return `
    <h2>${label} Request Received</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p>We have received your ${label.toLowerCase()} request for order #${escapeHtml(d.orderNumber)}.</p>
    <p><strong>${label} Number:</strong> ${escapeHtml(d.returnNumber)}</p>
    <p>Our team will review your request and get back to you within 1-2 business days.</p>
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      If you have any questions, please don't hesitate to contact our support team.
    </p>
    <p style="margin-top: 24px;">Thank you for your patience!</p>
    <p>Best regards,<br>${escapeHtml(d.storeName)} Team</p>
  `;
  },

  ar: (d: ReturnConfirmationData, _storeName: string) => {
    const label = typeLabelAr(d.type);
    const requestLabel = typeLabelArRequest(d.type);
    return `
    <h2>${requestLabel}</h2>
    <p>أهلاً ${escapeHtml(d.customerName)}،</p>
    <p>استلمنا طلب ${label} للطلب رقم ${escapeHtml(d.orderNumber)}.</p>
    <p><strong>رقم ${label}:</strong> ${escapeHtml(d.returnNumber)}</p>
    <p>فريقنا هيراجع طلبك ويرد عليك خلال يوم لحد يومين عمل.</p>
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      لو عندك أي سؤال، كلّم فريق الدعم في أي وقت.
    </p>
    <p style="margin-top: 24px;">شكراً على صبرك!</p>
    <p>تحياتنا،<br>فريق ${escapeHtml(d.storeName)}</p>
  `;
  },
};
