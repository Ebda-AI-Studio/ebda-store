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
        ? `عندك حساب بالفعل في ${d.storeName}`
        : 'عندك حساب بالفعل',
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
    <h2>عندك حساب بالفعل</h2>
    <p>أهلاً ${escapeHtml(d.name)}،</p>
    <p>
      حد حاول (يمكن تكون إنت) يسجّل بحساب جديد${storeRef}
      بالبريد الإلكتروني ده — بس عندك حساب بالفعل هنا.
    </p>
    <p>لو إنت اللي عملت كده، سجّل دخولك على طول:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${loginUrlEsc}" class="button">تسجيل الدخول</a>
    </p>
    <p>
      لو نسيت كلمة المرور،
      <a href="${resetUrlEsc}" style="color: ${BRAND.colors.gold};">اطلب رابط إعادة التعيين</a>.
    </p>
    <p style="font-size: 14px; color: #666; margin-top: 24px;">
      لو إنت معملتش كده، تجاهل الرسالة دي — مفيش أي تغيير اتعمل
      على حسابك. الأفضل تعيّن كلمة المرور من جديد لو فيه احتمال إن حد تاني عارف بريدك الإلكتروني.
    </p>
  `;
  },
};
