import { escapeHtml } from './_util';

export interface PasskeyNoticeData {
  email: string;
  name: string;
  kind: 'added' | 'removed';
  passkeyName: string;
  /** ISO timestamp, rendered as UTC with Latin digits (NUMERALS-1). */
  at: string;
}

const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** Security notice: a passkey was added to / removed from the account. Always sent, never skippable. */
export const passkeyNoticeTemplate = {
  subject: {
    en: (d: PasskeyNoticeData) =>
      d.kind === 'added'
        ? 'A passkey was added to your account'
        : 'A passkey was removed from your account',
    ar: (d: PasskeyNoticeData) =>
      d.kind === 'added' ? 'تمت إضافة مفتاح مرور إلى حسابك' : 'تم حذف مفتاح مرور من حسابك',
  },

  en: (d: PasskeyNoticeData) => `
    <h2>${d.kind === 'added' ? 'A passkey was added' : 'A passkey was removed'}</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>The passkey <strong>${escapeHtml(d.passkeyName)}</strong> was ${d.kind === 'added' ? 'added to' : 'removed from'} your account on ${escapeHtml(stamp(d.at))}.</p>
    <p>${
      d.kind === 'added'
        ? 'It can now sign in to your account without a password.'
        : 'You were signed out on all your devices.'
    }</p>
    <p><strong>If this was not you</strong>, reset your password right away. Resetting your password also removes every passkey on the account.</p>
  `,

  ar: (d: PasskeyNoticeData) => `
    <h2>${d.kind === 'added' ? 'تمت إضافة مفتاح مرور' : 'تم حذف مفتاح مرور'}</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>${d.kind === 'added' ? 'تمت إضافة' : 'تم حذف'} مفتاح المرور <strong>${escapeHtml(d.passkeyName)}</strong> ${d.kind === 'added' ? 'إلى' : 'من'} حسابك بتاريخ ${escapeHtml(stamp(d.at))}.</p>
    <p>${
      d.kind === 'added'
        ? 'يستطيع هذا المفتاح الآن تسجيل الدخول إلى حسابك بدون كلمة مرور.'
        : 'تم تسجيل خروجك من جميع أجهزتك.'
    }</p>
    <p><strong>إذا لم تكن أنت</strong>، غيّر كلمة المرور فوراً. تغيير كلمة المرور يحذف أيضاً كل مفاتيح المرور على الحساب.</p>
  `,
};
