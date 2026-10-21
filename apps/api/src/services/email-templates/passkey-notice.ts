import { escapeHtml } from './_util';

export interface PasskeyNoticeData {
  email: string;
  name: string;
  kind: 'added' | 'removed' | 'purged';
  passkeyName: string;
  /** purged only: how many passkeys were removed, and why. */
  count?: number;
  reason?: 'password_changed' | 'password_reset';
  /** ISO timestamp, rendered as UTC with Latin digits (NUMERALS-1). */
  at: string;
}

const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

const purgedWhy = (d: PasskeyNoticeData, lang: 'en' | 'ar') =>
  d.reason === 'password_reset'
    ? lang === 'en'
      ? 'reset'
      : 'إعادة تعيين'
    : lang === 'en'
      ? 'changed'
      : 'تغيير';

/**
 * Security notice: a passkey was added to / removed from the account, or every passkey was removed because
 * the password was changed or reset (PASSKEY-10, PASSKEY-13). Every claim in the copy is enforced by code:
 * `tests/unit/passkey-password-change.test.ts` pins the "removes all passkeys" sentences to
 * `AuthService.changePassword` and `AuthService.resetPassword`.
 */
export const passkeyNoticeTemplate = {
  subject: {
    en: (d: PasskeyNoticeData) =>
      d.kind === 'added'
        ? 'A passkey was added to your account'
        : d.kind === 'removed'
          ? 'A passkey was removed from your account'
          : 'Your passkeys were removed',
    ar: (d: PasskeyNoticeData) =>
      d.kind === 'added'
        ? 'تمت إضافة مفتاح مرور إلى حسابك'
        : d.kind === 'removed'
          ? 'تم حذف مفتاح مرور من حسابك'
          : 'تم حذف مفاتيح المرور من حسابك',
  },

  en: (d: PasskeyNoticeData) =>
    d.kind === 'purged'
      ? `
    <h2>Your passkeys were removed</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>Your password was ${purgedWhy(d, 'en')} on ${escapeHtml(stamp(d.at))}. For your safety, every passkey on your account (${d.count ?? 0}) was removed and you were signed out on all devices.</p>
    <p>Sign in with your new password. You can add your passkeys again from Security settings.</p>
    <p><strong>If this was not you</strong>, contact support right away.</p>
  `
      : `
    <h2>${d.kind === 'added' ? 'A passkey was added' : 'A passkey was removed'}</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>The passkey <strong>${escapeHtml(d.passkeyName)}</strong> was ${d.kind === 'added' ? 'added to' : 'removed from'} your account on ${escapeHtml(stamp(d.at))}.</p>
    <p>${
      d.kind === 'added'
        ? 'It can now sign in to your account without a password.'
        : 'You were signed out on all your devices.'
    }</p>
    <p><strong>If this was not you</strong>, change your password right away. Changing or resetting your password removes every passkey on the account.</p>
  `,

  ar: (d: PasskeyNoticeData) =>
    d.kind === 'purged'
      ? `
    <h2>تم حذف مفاتيح المرور</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>تم ${purgedWhy(d, 'ar')} كلمة المرور بتاريخ ${escapeHtml(stamp(d.at))}. حفاظاً على أمانك، تم حذف كل مفاتيح المرور على حسابك (${d.count ?? 0}) وتسجيل خروجك من جميع الأجهزة.</p>
    <p>سجّل الدخول بكلمة المرور الجديدة، ويمكنك إضافة مفاتيح المرور من جديد من إعدادات الأمان.</p>
    <p><strong>إذا لم تكن أنت</strong>، تواصل مع الدعم فوراً.</p>
  `
      : `
    <h2>${d.kind === 'added' ? 'تمت إضافة مفتاح مرور' : 'تم حذف مفتاح مرور'}</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>${d.kind === 'added' ? 'تمت إضافة' : 'تم حذف'} مفتاح المرور <strong>${escapeHtml(d.passkeyName)}</strong> ${d.kind === 'added' ? 'إلى' : 'من'} حسابك بتاريخ ${escapeHtml(stamp(d.at))}.</p>
    <p>${
      d.kind === 'added'
        ? 'يستطيع هذا المفتاح الآن تسجيل الدخول إلى حسابك بدون كلمة مرور.'
        : 'تم تسجيل خروجك من جميع أجهزتك.'
    }</p>
    <p><strong>إذا لم تكن أنت</strong>، غيّر كلمة المرور فوراً. تغيير كلمة المرور أو إعادة تعيينها يحذف كل مفاتيح المرور على الحساب.</p>
  `,
};
