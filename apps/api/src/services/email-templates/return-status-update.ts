import { escapeHtml } from './_util';

export interface ReturnStatusUpdateData {
  email: string;
  customerName: string;
  storeName: string;
  returnNumber: string;
  status: string;
  notes?: string;
}

const statusMessagesEn: Record<string, string> = {
  approved:
    'The return on your order has been approved! Please ship the items back to us using the provided instructions.',
  rejected: 'Unfortunately, we were unable to approve the return on your order.',
  shipped: 'We have noted that the items of the return on your order have been shipped.',
  received: 'We have received the returned items of your order and they are being inspected.',
  inspecting: 'The returned items of your order are currently being inspected by our team.',
  completed: 'The return on your order has been completed and the refund has been processed.',
  cancelled: 'The return on your order has been cancelled.',
};

const statusMessagesAr: Record<string, string> = {
  approved: 'وافقنا على الإرجاع الخاص بطلبك! ابعت المنتجات تاني حسب التعليمات المرفقة.',
  rejected: 'للأسف، معرفناش نوافق على الإرجاع الخاص بطلبك.',
  shipped: 'شفنا إن منتجات الإرجاع الخاص بطلبك اتشحنت.',
  received: 'استلمنا منتجات الإرجاع الخاص بطلبك وبنفحصها.',
  inspecting: 'فريقنا بيفحص منتجات الإرجاع الخاص بطلبك دلوقتي.',
  completed: 'الإرجاع الخاص بطلبك خلص واتعمل الاسترداد.',
  cancelled: 'الإرجاع الخاص بطلبك اتلغى.',
};

export const returnStatusUpdateTemplate = {
  subject: {
    en: (d: ReturnStatusUpdateData, _storeName: string) =>
      `Return Status Update - #${d.returnNumber}`,
    ar: (d: ReturnStatusUpdateData, _storeName: string) =>
      `تحديث الحالة - مرتجع رقم ${d.returnNumber}`,
  },

  en: (d: ReturnStatusUpdateData, _storeName: string) => {
    const message =
      statusMessagesEn[d.status] ||
      `The status of the return on your order has been updated to: ${escapeHtml(d.status)}`;
    return `
    <h2>Return Status Update</h2>
    <p>Hi ${escapeHtml(d.customerName)},</p>
    <p><strong>Return Number:</strong> ${escapeHtml(d.returnNumber)}</p>
    <p>${message}</p>
    ${d.notes ? `<p><strong>Note from our team:</strong> ${escapeHtml(d.notes)}</p>` : ''}
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      If you have any questions, please contact our support team.
    </p>
    <p>Best regards,<br>${escapeHtml(d.storeName)} Team</p>
  `;
  },

  ar: (d: ReturnStatusUpdateData, _storeName: string) => {
    const message =
      statusMessagesAr[d.status] || `حالة الإرجاع الخاص بطلبك اتحدّثت لـ: ${escapeHtml(d.status)}`;
    return `
    <h2>تحديث الحالة</h2>
    <p>أهلاً ${escapeHtml(d.customerName)}،</p>
    <p><strong>رقم المرتجع:</strong> ${escapeHtml(d.returnNumber)}</p>
    <p>${message}</p>
    ${d.notes ? `<p><strong>ملاحظة من فريقنا:</strong> ${escapeHtml(d.notes)}</p>` : ''}
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      لو عندك أي سؤال، كلّم فريق الدعم.
    </p>
    <p>تحياتنا،<br>فريق ${escapeHtml(d.storeName)}</p>
  `;
  },
};
