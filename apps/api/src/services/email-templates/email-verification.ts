import { escapeHtml } from './_util';
import { BRAND } from '@force/shared';

export interface EmailVerificationData {
  email: string;
  name: string;
  verificationUrl: string;
  // A count of hours, not a pre-formatted string (issue #1860, same class as
  // password-reset.ts's `expiresInMinutes`). The old `expiresIn: string`
  // let the caller bake in an English phrase ("24 hours") that the `ar`
  // template then embedded VERBATIM into Arabic copy on every registration.
  // Each language now formats its own copy from the same number.
  expiresInHours: number;
}

export const emailVerificationTemplate = {
  subject: {
    en: (_d: EmailVerificationData, _storeName: string) => 'Verify Your Email Address',
    ar: (_d: EmailVerificationData, _storeName: string) => 'تأكيد بريدك الإلكتروني',
  },

  en: (d: EmailVerificationData, _storeName: string) => {
    const urlEsc = escapeHtml(d.verificationUrl);
    return `
    <h2>Verify Your Email Address</h2>
    <p>Hi ${escapeHtml(d.name)},</p>
    <p>Thank you for registering! Please verify your email address to complete your account setup.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${urlEsc}" class="button">Verify Email</a>
    </p>
    <p>This link expires in ${d.expiresInHours} hours.</p>
    <p style="font-size: 14px; color: #666;">If you didn't create an account, you can safely ignore this email.</p>
    <p style="font-size: 12px; color: #999; margin-top: 24px;">
      If the button above doesn't work, copy and paste this link into your browser:<br>
      <a href="${urlEsc}" style="color: ${BRAND.colors.gold}; word-break: break-all;">${urlEsc}</a>
    </p>
  `;
  },

  ar: (d: EmailVerificationData, _storeName: string) => {
    const urlEsc = escapeHtml(d.verificationUrl);
    return `
    <h2>تأكيد بريدك الإلكتروني</h2>
    <p>مرحباً ${escapeHtml(d.name)}،</p>
    <p>شكراً للتسجيل! يُرجى تأكيد بريدك الإلكتروني لإتمام إعداد حسابك.</p>
    <p style="text-align: center; margin: 24px 0;">
      <a href="${urlEsc}" class="button">تأكيد البريد الإلكتروني</a>
    </p>
    <p>الرابط ينتهي خلال ${d.expiresInHours} ساعة.</p>
    <p style="font-size: 14px; color: #666;">إذا لم تنشئ حساباً، يمكنك تجاهل هذه الرسالة بأمان.</p>
    <p style="font-size: 12px; color: #999; margin-top: 24px;">
      إذا لم يعمل الزر أعلاه، انسخ هذا الرابط والصقه في متصفحك:<br>
      <a href="${urlEsc}" style="color: ${BRAND.colors.gold}; word-break: break-all;">${urlEsc}</a>
    </p>
  `;
  },
};
