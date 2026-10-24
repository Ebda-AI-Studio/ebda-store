import { escapeHtml } from './_util';

export interface FactorAddedNoticeData {
  email: string;
  name: string;
  factor: 'totp' | 'passkey';
}

/** Security notice: a new sign-in method (authenticator app or passkey) was added to the account (Ruling ID-15). */
export const factorAddedNoticeTemplate = {
  subject: {
    en: (_d: FactorAddedNoticeData) => 'A new sign-in method was added to your account',
    ar: (_d: FactorAddedNoticeData) => 'اتضافت وسيلة تسجيل دخول جديدة لحسابك',
  },
  en: (d: FactorAddedNoticeData) => `
    <h2>New sign-in method added</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>${d.factor === 'totp' ? 'An authenticator app' : 'A passkey'} was just added to your Ebda account.</p>
    <p>If this was you, nothing more to do. If it was not, reset your password right away and contact support: whoever added it can sign in as you.</p>
  `,
  ar: (d: FactorAddedNoticeData) => `
    <h2>اتضافت وسيلة تسجيل دخول جديدة</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>${d.factor === 'totp' ? 'تطبيق مصادقة' : 'مفتاح مرور'} اتضاف لحسابك في إبدا دلوقتي.</p>
    <p>لو إنت اللي عملت كده مفيش حاجة مطلوبة. لو مش إنت، غيّر كلمة المرور فوراً وكلّم الدعم: اللي ضافها يقدر يدخل بحسابك.</p>
  `,
};
