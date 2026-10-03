import { escapeHtml } from './_util';
import { BRAND } from '@force/shared';

export interface ResendVerificationData {
  email: string;
  name: string;
  verificationUrl: string;
  // A count of hours, not a pre-formatted string — same fix as
  // email-verification.ts (#1860): each language formats its own copy from
  // the number instead of a caller-supplied English phrase getting embedded
  // verbatim into the Arabic template.
  expiresInHours: number;
}

export const resendVerificationTemplate = {
  subject: {
    en: (_d: ResendVerificationData, _storeName: string) => 'Verify Your Email Address - New Link',
    ar: (_d: ResendVerificationData, _storeName: string) => 'تأكيد بريدك الإلكتروني - رابط جديد',
  },

  en: (d: ResendVerificationData, _storeName: string) => {
    const urlEsc = escapeHtml(d.verificationUrl);
    return `
    <h2>New Verification Link</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>Here's your new email verification link as requested.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${urlEsc}" class="button">Verify Email</a>
    </p>
    <p>This link expires in ${d.expiresInHours} hours.</p>
    <p style="font-size: 14px; color: #666;">If you didn't request this, please contact support.</p>
    <p style="font-size: 12px; color: #999; margin-top: 24px;">
      If the button above doesn't work, copy and paste this link into your browser:<br>
      <a href="${urlEsc}" style="color: ${BRAND.colors.gold}; word-break: break-all;">${urlEsc}</a>
    </p>
  `;
  },

  ar: (d: ResendVerificationData, _storeName: string) => {
    const urlEsc = escapeHtml(d.verificationUrl);
    return `
    <h2>رابط تحقق جديد</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>هذا هو رابط التحقق الجديد من بريدك الإلكتروني كما طلبت.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${urlEsc}" class="button">تأكيد البريد الإلكتروني</a>
    </p>
    <p>الرابط ينتهي خلال ${d.expiresInHours} ساعة.</p>
    <p style="font-size: 14px; color: #666;">إذا لم تطلب ذلك، يُرجى التواصل مع الدعم.</p>
    <p style="font-size: 12px; color: #999; margin-top: 24px;">
      إذا لم يعمل الزر أعلاه، انسخ هذا الرابط والصقه في متصفحك:<br>
      <a href="${urlEsc}" style="color: ${BRAND.colors.gold}; word-break: break-all;">${urlEsc}</a>
    </p>
  `;
  },
};
