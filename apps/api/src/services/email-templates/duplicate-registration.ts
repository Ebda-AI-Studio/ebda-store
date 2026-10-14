import { escapeHtml } from './_util';
import { BRAND } from '@ebda/shared';

export interface DuplicateRegistrationData {
  email: string;
  name: string;
  storeName?: string;
}

export const duplicateRegistrationTemplate = {
  subject: {
    en: (d: DuplicateRegistrationData, _storeName: string) =>
      d.storeName && d.storeName.length > 0
        ? `Account already exists at ${d.storeName}`
        : 'Account already exists',
    ar: (d: DuplicateRegistrationData, _storeName: string) =>
      d.storeName && d.storeName.length > 0
        ? `لديك حساب مسبقاً في ${d.storeName}`
        : 'لديك حساب مسبقاً',
  },

  en: (d: DuplicateRegistrationData, _storeName: string, webUrl: string) => {
    const loginUrlEsc = escapeHtml(`${webUrl}/auth/login`);
    const resetUrlEsc = escapeHtml(`${webUrl}/auth/forgot-password`);
    const storeRef = d.storeName ? ` at ${escapeHtml(d.storeName)}` : '';
    return `
    <h2>Account already exists</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>
      Someone (possibly you) just tried to register a new account${storeRef}
      using this email address — but you already have an account here.
    </p>
    <p>If this was you, just sign in normally:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${loginUrlEsc}" class="button">Sign in</a>
    </p>
    <p>
      If you've forgotten your password, you can
      <a href="${resetUrlEsc}" style="color: ${BRAND.colors.gold};">request a reset link</a>.
    </p>
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      If this wasn't you, you can ignore this email — no changes were
      made to your account. We recommend resetting your password if
      you think someone else has your email address.
    </p>
  `;
  },

  ar: (d: DuplicateRegistrationData, _storeName: string, webUrl: string) => {
    const loginUrlEsc = escapeHtml(`${webUrl}/auth/login`);
    const resetUrlEsc = escapeHtml(`${webUrl}/auth/forgot-password`);
    const storeRef = d.storeName ? ` في ${escapeHtml(d.storeName)}` : '';
    return `
    <h2>لديك حساب مسبقاً</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>
      حاول شخص ما (ربما أنت) التسجيل بحساب جديد${storeRef}
      باستخدام هذا البريد الإلكتروني — غير أن لديك حساباً بالفعل هنا.
    </p>
    <p>إذا كنت أنت من طلب ذلك، يمكنك تسجيل الدخول مباشرة:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${loginUrlEsc}" class="button">تسجيل الدخول</a>
    </p>
    <p>
      إذا نسيت كلمة المرور، يمكنك
      <a href="${resetUrlEsc}" style="color: ${BRAND.colors.gold};">طلب رابط إعادة التعيين</a>.
    </p>
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      إذا لم تكن أنت من فعل ذلك، يمكنك تجاهل هذه الرسالة — لم يتم إجراء أي تغييرات
      على حسابك. ننصحك بإعادة تعيين كلمة المرور إذا كنت تعتقد أن شخصاً آخر يعرف بريدك الإلكتروني.
    </p>
  `;
  },
};
