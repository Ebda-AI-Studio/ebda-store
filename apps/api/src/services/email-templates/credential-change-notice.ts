import { escapeHtml } from './_util';

type CredentialChange = 'mfa_disabled' | 'passkey_removed' | 'phone_changed';

export interface CredentialChangeNoticeData {
  email: string;
  name: string;
  change: CredentialChange;
}

const EN: Record<CredentialChange, string> = {
  mfa_disabled: 'The authenticator app (two-step verification) was turned off',
  passkey_removed: 'A passkey was removed',
  phone_changed: 'The phone number used to recover your account was changed',
};
const AR: Record<CredentialChange, string> = {
  mfa_disabled: 'التحقق بخطوتين (تطبيق المصادقة) اتقفل',
  passkey_removed: 'مفتاح مرور اتشال',
  phone_changed: 'رقم التليفون اللي بيستخدم لاسترجاع حسابك اتغيّر',
};

/**
 * Security notice (ID-06): a recovery-relevant credential of the account changed. Every OTHER session was signed out at the
 * same moment, so the mail says so; the session that made the change stays.
 */
export const credentialChangeNoticeTemplate = {
  subject: {
    en: (_d: CredentialChangeNoticeData) => 'A security setting on your account was changed',
    ar: (_d: CredentialChangeNoticeData) => 'اتغيّر إعداد أمان في حسابك',
  },
  en: (d: CredentialChangeNoticeData) => `
    <h2>Security setting changed</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>${EN[d.change] ?? 'A security setting changed'} on your Ebda AI Studio account. Your other devices were signed out.</p>
    <p>If this was you, nothing more to do. If it was not: reset your password right away, then review Account &gt; Security, and contact support.</p>
  `,
  ar: (d: CredentialChangeNoticeData) => `
    <h2>اتغيّر إعداد أمان</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>${AR[d.change] ?? 'اتغيّر إعداد أمان'} في حسابك على ابدأ ستوديو للذكاء الاصطناعي. وكل الأجهزة التانية اتسجّل خروجها.</p>
    <p>لو إنت اللي عملت كده مفيش حاجة مطلوبة. لو مش إنت: غيّر كلمة المرور فوراً، وراجع الحساب &gt; الأمان، وكلّم الدعم.</p>
  `,
};
