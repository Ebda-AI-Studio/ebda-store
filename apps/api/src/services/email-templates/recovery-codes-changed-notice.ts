import { escapeHtml } from './_util';

export interface RecoveryCodesChangedNoticeData {
  email: string;
  name: string;
}

/** Security notice: the two-step verification recovery codes of the account were replaced (A23). */
export const recoveryCodesChangedNoticeTemplate = {
  subject: {
    en: (_d: RecoveryCodesChangedNoticeData) => 'Your recovery codes were changed',
    ar: (_d: RecoveryCodesChangedNoticeData) => 'أكواد الاسترجاع بتاعتك اتغيّرت',
  },
  en: (d: RecoveryCodesChangedNoticeData) => `
    <h2>Your recovery codes were changed</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>A new set of two-step recovery codes was just created for your Ebda AI Studio account. Your old codes no longer work.</p>
    <p>If this was you, nothing more to do. If it was not: reset your password at once, then check Account &gt; Security, and contact support.</p>
  `,
  ar: (d: RecoveryCodesChangedNoticeData) => `
    <h2>أكواد الاسترجاع بتاعتك اتغيّرت</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>اتعملت مجموعة جديدة من أكواد الاسترجاع للتحقق بخطوتين لحسابك في ابدأ ستوديو للذكاء الاصطناعي. الأكواد القديمة بطلت تشتغل.</p>
    <p>لو إنت اللي عملت كده مفيش حاجة مطلوبة. لو مش إنت: غيّر كلمة المرور فوراً، وبعدين راجع الحساب &gt; الأمان، وكلّم الدعم.</p>
  `,
};
