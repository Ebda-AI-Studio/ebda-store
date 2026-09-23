import { escapeHtml } from './_util';

export interface PasswordResetData {
  email: string;
  name: string;
  resetUrl: string;
  // A count of minutes, not a pre-formatted string (S5-2, 2026-09-22
  // security audit). The old `expiresIn: string` field let the caller bake
  // in an English phrase ("1 hour") that the `ar` template below then
  // embedded VERBATIM into Arabic copy — every Arabic password-reset email
  // read "...ينتهي خلال 1 hour", English text inside Arabic. Each language
  // now formats its own copy from the same number, so a TTL change (or a
  // language change) can never again desync the copy from the behaviour or
  // from itself.
  expiresInMinutes: number;
}

export const passwordResetTemplate = {
  subject: {
    en: (_d: PasswordResetData, _storeName: string) => 'Reset Your Password',
    ar: (_d: PasswordResetData, _storeName: string) => 'إعادة تعيين كلمة المرور',
  },

  en: (d: PasswordResetData, _storeName: string) => `
    <h2>Reset Your Password</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>We received a request to reset your password. Click the button below to create a new password:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.resetUrl)}" class="button">Reset Password</a>
    </p>
    <p>This link expires in ${d.expiresInMinutes} minutes.</p>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `,

  ar: (d: PasswordResetData, _storeName: string) => `
    <h2>إعادة تعيين كلمة المرور</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>تلقينا طلباً لإعادة تعيين كلمة المرور. اضغط أدناه لإنشاء كلمة مرور جديدة:</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(d.resetUrl)}" class="button">إعادة تعيين كلمة المرور</a>
    </p>
    <p>الرابط ينتهي خلال ${d.expiresInMinutes} دقيقة.</p>
    <p>إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.</p>
  `,
};
