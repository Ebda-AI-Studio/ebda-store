import { escapeHtml } from './_util';

export interface StaffInviteData {
  email: string;
  name: string;
  storeName: string;
  loginUrl: string;
  /** Null when the account already has a working password (added to another store). */
  setPasswordUrl: string | null;
  /** An existing account: the explicit accept step (sign in as this address, then accept). Wins over the other two. */
  acceptUrl?: string | null;
  expiresInMinutes: number;
}

export const staffInviteTemplate = {
  subject: {
    en: (d: StaffInviteData, _storeName: string) => `You've been added as staff for ${d.storeName}`,
    ar: (d: StaffInviteData, _storeName: string) => `تمت إضافتك كموظف في ${d.storeName}`,
  },

  en: (d: StaffInviteData, _storeName: string) => `
    <h2>You've been added as staff</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>You've been added as a staff member for <strong>${escapeHtml(d.storeName)}</strong>.</p>
    ${
      d.acceptUrl
        ? `
    <p>Sign in with this email address and accept the invitation to get access. Nothing changes until you accept.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.acceptUrl)}" class="button">Accept the invitation</a>
    </p>
    <p>This link expires in ${Math.round(d.expiresInMinutes / 60)} hours. If your account is a store owner's, it becomes a staff account when you accept, so use a different address if you own a store.</p>
    `
        : d.setPasswordUrl
          ? `
    <p>Set your password to get started:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.setPasswordUrl)}" class="button">Set Your Password</a>
    </p>
    <p>This link expires in ${d.expiresInMinutes} minutes. After that, use "Forgot password" on the sign-in page with this email address.</p>
    `
          : `
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.loginUrl)}" class="button">Sign In</a>
    </p>
    <p>Sign in with the email and password you already use.</p>
    `
    }
    <p>If you weren't expecting this, contact the store owner.</p>
  `,

  ar: (d: StaffInviteData, _storeName: string) => `
    <h2>تمت إضافتك كموظف</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>تمت إضافتك كموظف في متجر <strong>${escapeHtml(d.storeName)}</strong>.</p>
    ${
      d.acceptUrl
        ? `
    <p>سجّل الدخول بنفس هذا البريد ووافق على الدعوة عشان تاخد الصلاحية. مفيش حاجة بتتغير قبل ما توافق.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.acceptUrl)}" class="button">قبول الدعوة</a>
    </p>
    <p>الرابط ينتهي خلال ${Math.round(d.expiresInMinutes / 60)} ساعة. لو حسابك حساب صاحب متجر هيتحوّل لحساب موظف لما توافق، فاستخدم بريد تاني لو عندك متجر.</p>
    `
        : d.setPasswordUrl
          ? `
    <p>اضبط كلمة المرور الخاصة بك للبدء:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.setPasswordUrl)}" class="button">اضبط كلمة المرور</a>
    </p>
    <p>الرابط ينتهي خلال ${d.expiresInMinutes} دقيقة. بعدها استخدم «نسيت كلمة المرور» في صفحة تسجيل الدخول بنفس البريد الإلكتروني.</p>
    `
          : `
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.loginUrl)}" class="button">تسجيل الدخول</a>
    </p>
    <p>سجّل الدخول بنفس البريد وكلمة المرور اللي عندك بالفعل.</p>
    `
    }
    <p>لو ده حصل من غير ما تتوقعه، كلّم صاحب المتجر.</p>
  `,
};
