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
    'Your return request has been approved! Please ship the items back to us using the provided instructions.',
  rejected: 'Unfortunately, we were unable to approve your return request.',
  shipped: 'We have noted that your return items have been shipped.',
  received: 'We have received your returned items and they are being inspected.',
  inspecting: 'Your items are currently being inspected by our team.',
  completed: 'Your return has been completed and your refund has been processed.',
  cancelled: 'Your return request has been cancelled.',
};

const statusMessagesAr: Record<string, string> = {
  approved: 'تمت الموافقة على طلب الإرجاع! يُرجى إعادة إرسال المنتجات وفق التعليمات المُرفقة.',
  rejected: 'للأسف، لم نتمكن من الموافقة على طلب الإرجاع.',
  shipped: 'لاحظنا أنه تم شحن منتجات الإرجاع.',
  received: 'استلمنا منتجات الإرجاع وهي قيد الفحص.',
  inspecting: 'يقوم فريقنا حالياً بفحص المنتجات.',
  completed: 'اكتمل الإرجاع وتمت معالجة الاسترداد.',
  cancelled: 'تم إلغاء طلب الإرجاع.',
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
      `Your return request status has been updated to: ${escapeHtml(d.status)}`;
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
      statusMessagesAr[d.status] || `تم تحديث حالة طلب الإرجاع إلى: ${escapeHtml(d.status)}`;
    return `
    <h2>تحديث الحالة</h2>
    <p>مرحباً ${escapeHtml(d.customerName)}،</p>
    <p><strong>رقم المرتجع:</strong> ${escapeHtml(d.returnNumber)}</p>
    <p>${message}</p>
    ${d.notes ? `<p><strong>ملاحظة من فريقنا:</strong> ${escapeHtml(d.notes)}</p>` : ''}
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      إذا كان لديك أي استفسار، يُرجى التواصل مع فريق الدعم.
    </p>
    <p>مع أطيب التحيات،<br>فريق ${escapeHtml(d.storeName)}</p>
  `;
  },
};
