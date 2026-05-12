/**
 * Bilingual email-template registry.
 *
 * Each module exports a template object with three keys:
 *   - subject: { en, ar }   — subject-line builders
 *   - en: (data, storeName, webUrl?) => string   — English body (inner HTML)
 *   - ar: (data, storeName, webUrl?) => string   — Arabic body (inner HTML)
 *
 * Template functions receive:
 *   1. The typed data object for that email
 *   2. The store display name (already loaded by the caller)
 *   3. Optionally the webUrl (for link generation) — only required on templates
 *      that render CTA links (welcome, password-reset, etc.)
 */

export { welcomeTemplate } from './welcome';
export type { WelcomeData } from './welcome';

export { passwordResetTemplate } from './password-reset';
export type { PasswordResetData } from './password-reset';

export { emailVerificationTemplate } from './email-verification';
export type { EmailVerificationData } from './email-verification';

export { resendVerificationTemplate } from './resend-verification';
export type { ResendVerificationData } from './resend-verification';

export { duplicateRegistrationTemplate } from './duplicate-registration';
export type { DuplicateRegistrationData } from './duplicate-registration';

export { orderConfirmationTemplate } from './order-confirmation';

export { paymentSuccessTemplate } from './payment-success';

export { paymentFailedTemplate } from './payment-failed';
export type { PaymentFailedData } from './payment-failed';

export { orderShippedTemplate } from './order-shipped';
export type { OrderShippedData } from './order-shipped';

export { returnConfirmationTemplate } from './return-confirmation';
export type { ReturnConfirmationData } from './return-confirmation';

export { returnStatusUpdateTemplate } from './return-status-update';
export type { ReturnStatusUpdateData } from './return-status-update';
