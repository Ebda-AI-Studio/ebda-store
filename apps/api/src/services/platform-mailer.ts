/**
 * Platform-level (no store) transactional mail for the self-serve merchant
 * funnel: signup email verification and the "you already have an account"
 * notice. A merchant has no store yet, so the branded per-store sender cannot
 * be used.
 *
 * Delivery policy:
 *  - production + a mail transport configured  -> real mail via the platform sender.
 *  - everything else (dev, test, CI) -> NEVER sent. The message is captured in
 *    a bounded in-process outbox (read by tests and the scripted E2E) and the
 *    verification link is logged at info level for local dev.
 *
 * The outbox is process-local on purpose: it is not a queue and is never
 * exposed over HTTP.
 */
import { BRAND, BRAND_EMAIL_LOGO_URL, productName, resolveDefaultLanguage } from '@ebda/shared';
import { config } from '../config';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
import { isMailTransportConfigured } from './mail-transport';
import { EmailService, renderBrandedShell } from './email.service';
import { emailVerificationTemplate } from './email-templates/email-verification';
import { passwordResetTemplate } from './email-templates/password-reset';
import { staffInviteTemplate, type StaffInviteData } from './email-templates/staff-invite';
import {
  factorAddedNoticeTemplate,
  type FactorAddedNoticeData,
} from './email-templates/factor-added-notice';
import {
  chatMemberAddedTemplate,
  type ChatMemberAddedData,
} from './email-templates/chat-member-added';
import {
  factorEnrolCodeTemplate,
  type FactorEnrolCodeData,
} from './email-templates/factor-enrol-code';
import { legalNoticeTemplate, type LegalNoticeEmailData } from './email-templates/legal-notice';
import { passkeyNoticeTemplate, type PasskeyNoticeData } from './email-templates/passkey-notice';
import { escapeHtml } from './email-templates/_util';

export interface CapturedMail {
  to: string;
  subject: string;
  html: string;
  /** First absolute http(s) link in the body, for tests that follow it. */
  link: string | null;
  replyTo?: string;
  at: Date;
}

const OUTBOX_LIMIT = 200;
const outbox: CapturedMail[] = [];

export function getCapturedMail(): readonly CapturedMail[] {
  return outbox;
}

export function clearCapturedMail(): void {
  outbox.length = 0;
}

/** Newest captured message addressed to `to` (case-insensitive), if any. */
export function latestCapturedMailTo(to: string): CapturedMail | undefined {
  const needle = to.trim().toLowerCase();
  for (let i = outbox.length - 1; i >= 0; i--) {
    if (outbox[i].to.toLowerCase() === needle) return outbox[i];
  }
  return undefined;
}

/** Pull the `token` query param out of a captured verification mail. */
export function tokenFromCapturedMail(mail: CapturedMail | undefined): string | null {
  if (!mail?.link) return null;
  try {
    return new URL(mail.link).searchParams.get('token');
  } catch {
    return null;
  }
}

function shouldReallySend(): boolean {
  return config.nodeEnv === 'production' && isMailTransportConfigured();
}

/**
 * The captured link with its `token` query param masked, for the dev log line.
 * A password-reset token is a bearer credential for the whole account, so it
 * never reaches a log sink, even in development (the outbox keeps the real
 * link for tests).
 */
function redactTokenParam(link: string | null): string | null {
  if (!link) return link;
  try {
    const u = new URL(link);
    if (u.searchParams.has('token')) u.searchParams.set('token', '[redacted]');
    return u.toString();
  } catch {
    return '[unparseable link]';
  }
}

async function deliver(
  msg: { to: string; subject: string; html: string; replyTo?: string; fromName?: string },
  opts: { redactLinkInLog?: boolean } = {}
): Promise<void> {
  if (shouldReallySend()) {
    await EmailService.sendPlatformRaw({
      // Account mail comes from the studio (accounts.ebda.app), not the store product (BRAND-NAME-1).
      fromName: BRAND.name,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.fromName ? { fromName: msg.fromName } : {}),
    });
    return;
  }
  const link = /href="(https?:\/\/[^"]+)"/.exec(msg.html)?.[1]?.replace(/&amp;/g, '&') ?? null;
  outbox.push({ ...msg, link, at: new Date() });
  if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT);
  if (config.nodeEnv === 'production') {
    // Production without a Resend key must be loud, never silently "sent".
    logger.error(
      { to: maskEmail(msg.to), subject: msg.subject },
      '[PLATFORM-MAIL] no mail transport (EMAIL binding) in production - mail NOT delivered'
    );
  } else {
    logger.info(
      {
        to: maskEmail(msg.to),
        subject: msg.subject,
        link: opts.redactLinkInLog ? redactTokenParam(link) : link,
      },
      '[PLATFORM-MAIL] captured (not sent outside production)'
    );
  }
}

type Lang = 'en' | 'ar';

export async function sendMerchantVerificationEmail(
  data: { email: string; name: string; verificationUrl: string; expiresInHours: number },
  language?: Lang,
  /** Sent on behalf of the shared identity service: master brand (Ebda AI Studio), never the product name. */
  studio = false
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const content = emailVerificationTemplate[lang](
    data,
    studio ? (lang === 'ar' ? BRAND.nameAr : BRAND.name) : productName(lang)
  );
  const html = renderBrandedShell(content, {
    name: BRAND.name,
    nameAr: BRAND.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
    // the sender already is the master brand: no "Powered by <product>" footer
    hidePoweredBy: studio,
  });
  await deliver({
    to: data.email,
    subject: emailVerificationTemplate.subject[lang](data, ''),
    html,
    ...(studio ? { fromName: BRAND.name } : {}),
  });
}

/**
 * Sent when someone submits the signup form with an address that already has
 * a merchant account. The HTTP response is identical to a fresh signup (no
 * enumeration); the rightful owner learns about it here.
 */
export async function sendMerchantDuplicateSignupNotice(
  data: { email: string; name: string },
  language?: Lang
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const loginUrl = escapeHtml(`${config.adminUrl}/login`);
  const name = escapeHtml(data.name);
  const content =
    lang === 'ar'
      ? `<h2>لديك حساب مسبقاً</h2><p>مرحباً ${name}،</p><p>حاول شخص ما (ربما أنت) إنشاء متجر جديد بهذا البريد، لكن لديك حساب بالفعل. إذا كنت أنت، سجّل الدخول مباشرة.</p><p style="text-align:center;margin:24px 0;"><a href="${loginUrl}" class="button">تسجيل الدخول</a></p><p style="font-size:14px;color:#666;">إذا لم تكن أنت فتجاهل هذه الرسالة؛ لم يتغير شيء في حسابك.</p>`
      : `<h2>You already have an account</h2><p>Hi ${name},</p><p>Someone (possibly you) just tried to start a new store with this email, but an account already exists. If it was you, just sign in.</p><p style="text-align:center;margin:24px 0;"><a href="${loginUrl}" class="button">Sign in</a></p><p style="font-size:14px;color:#666;">If this wasn't you, ignore this email; nothing changed on your account.</p>`;
  const html = renderBrandedShell(content, {
    name: BRAND.name,
    nameAr: BRAND.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
  });
  await deliver({
    to: data.email,
    subject: lang === 'ar' ? 'لديك حساب مسبقاً' : 'You already have an account',
    html,
  });
}

/**
 * Password reset for an account in the admin namespace (`users.store_id`
 * NULL): a merchant on Ebda Store. The per-store branded sender needs a store,
 * so this goes out from the platform sender (`Ebda Store <no-reply@ebda.app>`)
 * with replies routed to the support inbox. Same template, same TTL copy as
 * the storefront customer reset.
 */
export async function sendMerchantPasswordResetEmail(
  data: { email: string; name: string; resetUrl: string; expiresInMinutes: number },
  language?: Lang,
  /** Sent on behalf of the shared identity service: master brand (Ebda AI Studio), never the product name. */
  studio = false
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const content = passwordResetTemplate[lang](
    data,
    studio ? (lang === 'ar' ? BRAND.nameAr : BRAND.name) : productName(lang)
  );
  const html = renderBrandedShell(content, {
    name: BRAND.name,
    nameAr: BRAND.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
    // the sender already is the master brand: no "Powered by <product>" footer
    hidePoweredBy: studio,
  });
  await deliver(
    {
      to: data.email,
      subject: passwordResetTemplate.subject[lang](data, ''),
      html,
      ...(studio ? { fromName: BRAND.name } : {}),
      replyTo: BRAND.supportEmail,
    },
    { redactLinkInLog: true }
  );
}

/**
 * Sent whenever a store owner adds someone as staff (R-EBDA lens-2 "staff
 * invite consent", 2026-09-22 security audit: there was no invite-token flow
 * at all — a staff account could be created with a password nobody but the
 * owner knew, with no way for the invitee to discover they had an account
 * except guessing "forgot password"). Always notified now; carries a working
 * set-password link for a brand-new account, or none when the account already
 * has a password (added to a second store).
 */
export async function sendStaffInviteEmail(
  data: StaffInviteData,
  language?: Lang,
  /** Sent on behalf of the shared identity service: master brand (Ebda AI Studio), never the product name. */
  studio = false
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const content = staffInviteTemplate[lang](data, '');
  const html = renderBrandedShell(content, {
    name: BRAND.name,
    nameAr: BRAND.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
    // the sender already is the master brand: no "Powered by <product>" footer
    hidePoweredBy: studio,
  });
  await deliver(
    {
      to: data.email,
      subject: staffInviteTemplate.subject[lang](data, ''),
      html,
      ...(studio ? { fromName: BRAND.name } : {}),
      replyTo: BRAND.supportEmail,
    },
    { redactLinkInLog: true }
  );
}

/** A sign-in method was added to the account (Ruling ID-15). */
export async function sendFactorAddedNoticeEmail(
  data: FactorAddedNoticeData,
  language?: Lang,
  /** Sent on behalf of the shared identity service: master brand (Ebda AI Studio), never the product name. */
  studio = false
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const html = renderBrandedShell(factorAddedNoticeTemplate[lang](data), {
    name: studio ? BRAND.name : BRAND.product.nameEn,
    nameAr: studio ? BRAND.nameAr : BRAND.product.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
    // the sender already is the master brand: no "Powered by <product>" footer
    hidePoweredBy: studio,
  });
  await deliver({
    to: data.email,
    subject: factorAddedNoticeTemplate.subject[lang](data),
    html,
    ...(studio ? { fromName: BRAND.name } : {}),
    replyTo: BRAND.supportEmail,
  });
}

/** An existing identity was added to a standalone Ebda Chat workspace. Master-brand sender (the identity service). */
export async function sendChatMemberAddedEmail(
  data: ChatMemberAddedData,
  language?: Lang
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const html = renderBrandedShell(chatMemberAddedTemplate[lang](data), {
    name: BRAND.name,
    nameAr: BRAND.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
    hidePoweredBy: true,
  });
  await deliver({
    to: data.email,
    subject: chatMemberAddedTemplate.subject[lang](data),
    html,
    fromName: BRAND.name,
    replyTo: BRAND.supportEmail,
  });
}

/** Platform-administrator first-factor enrolment code (Ruling ID-15). */
export async function sendFactorEnrolCodeEmail(
  data: FactorEnrolCodeData,
  language?: Lang,
  /** Sent on behalf of the shared identity service: master brand (Ebda AI Studio), never the product name. */
  studio = false
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const html = renderBrandedShell(factorEnrolCodeTemplate[lang](data), {
    name: studio ? BRAND.name : BRAND.product.nameEn,
    nameAr: studio ? BRAND.nameAr : BRAND.product.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
    // the sender already is the master brand: no "Powered by <product>" footer
    hidePoweredBy: studio,
  });
  await deliver(
    {
      to: data.email,
      subject: factorEnrolCodeTemplate.subject[lang](data),
      html,
      ...(studio ? { fromName: BRAND.name } : {}),
      replyTo: BRAND.supportEmail,
    },
    { redactLinkInLog: true }
  );
}

/**
 * "A passkey was added/removed" security notice (Ruling PASSKEY-9). Platform sender for merchants and
 * shoppers alike: it is an account-security message, not store marketing.
 */
export async function sendPasskeyNoticeEmail(
  data: PasskeyNoticeData,
  language?: Lang
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const html = renderBrandedShell(passkeyNoticeTemplate[lang](data), {
    name: BRAND.name,
    nameAr: BRAND.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
  });
  await deliver({
    to: data.email,
    subject: passkeyNoticeTemplate.subject[lang](data),
    html,
    replyTo: BRAND.supportEmail,
  });
}

/**
 * False when a legal notice could not really be delivered (production without a mail transport). The
 * fan-out checks it ONCE at the start of a run (Ruling LEGAL-5, I2), so an unconfigured mailer
 * fails the run fast instead of burning a pacer slot per recipient.
 */
export function legalNoticeMailerReady(): boolean {
  return !(config.nodeEnv === 'production' && !isMailTransportConfigured());
}

/**
 * Material policy-change notice to a store owner (Rulings LEGAL-4, LEGAL-6). ONE bilingual
 * email (Arabic block first, then English) whatever `users.language` says. Called once per
 * recipient by the `legal-notice-send` Inngest function, which owns idempotency
 * (legal_notice_deliveries) and throttling (the platform send pacer).
 *
 * A transactional legal/service notice, NOT marketing: it carries no unsubscribe link by
 * design (Ruling LEGAL-4), and the email says so in its footer line.
 *
 * Throws on a provider error so the caller marks the delivery `failed`. Unlike the other
 * platform mails it also throws in production when Resend is not configured: `deliver`
 * would only log there, and the fan-out would record a mail nobody received as `sent`.
 */
export async function sendLegalNoticeEmail(
  data: LegalNoticeEmailData & { email: string }
): Promise<void> {
  // Belt and braces: the job checks legalNoticeMailerReady() ONCE before its first batch.
  if (!legalNoticeMailerReady()) throw new Error('MAIL_NOT_CONFIGURED');
  const html = renderBrandedShell(legalNoticeTemplate.body(data), {
    name: BRAND.name,
    nameAr: BRAND.nameAr,
    logo: BRAND_EMAIL_LOGO_URL,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: 'ar',
  });
  await deliver({
    to: data.email,
    subject: legalNoticeTemplate.subject(),
    html,
    replyTo: BRAND.supportEmail,
  });
}
