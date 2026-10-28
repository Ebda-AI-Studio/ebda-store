import { escapeHtml } from './_util';

export interface FactorEnrolCodeData {
  email: string;
  name: string;
  /** Six digits. Shown in the body (not in a link): the person types it into the page they are already on. */
  code: string;
  expiresInMinutes: number;
}

/**
 * Platform-administrator first-factor enrolment code (Ruling ID-15). Together with the one-time token the operator's own
 * script printed, this proves control of the mailbox before a first sign-in factor can be bound to the account.
 */
export const factorEnrolCodeTemplate = {
  subject: {
    en: (_d: FactorEnrolCodeData) => 'Your code to set up two-step sign-in',
    ar: (_d: FactorEnrolCodeData) => 'الكود بتاعك لتفعيل التحقق بخطوتين',
  },
  en: (d: FactorEnrolCodeData) => `
    <h2>Set up two-step sign-in</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>Enter this code on the setup page to add your first sign-in factor:</p>
    <p style="text-align: center; margin: 24px 0; font-size: 28px; letter-spacing: 6px;"><strong dir="ltr">${escapeHtml(d.code)}</strong></p>
    <p>It expires in ${d.expiresInMinutes} minutes and works once. If you did not ask for it, do not enter it anywhere and tell the platform operator.</p>
  `,
  ar: (d: FactorEnrolCodeData) => `
    <h2>تفعيل التحقق بخطوتين</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>اكتب الكود ده في صفحة الإعداد عشان تضيف أول وسيلة تسجيل دخول:</p>
    <p style="text-align: center; margin: 24px 0; font-size: 28px; letter-spacing: 6px;"><strong dir="ltr">${escapeHtml(d.code)}</strong></p>
    <p>الكود بينتهي بعد ${d.expiresInMinutes} دقيقة وبيشتغل مرة واحدة. لو مش إنت اللي طلبته متكتبهوش في أي مكان وبلّغ مشغّل المنصة.</p>
  `,
};
