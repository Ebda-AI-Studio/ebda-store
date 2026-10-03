/**
 * Platform-level (no store) transactional mail for the self-serve merchant
 * funnel: signup email verification and the "you already have an account"
 * notice. A merchant has no store yet, so the branded per-store sender cannot
 * be used.
 *
 * Delivery policy:
 *  - production + Resend configured  -> real mail via the platform sender.
 *  - everything else (dev, test, CI) -> NEVER sent. The message is captured in
 *    a bounded in-process outbox (read by tests and the scripted E2E) and the
 *    verification link is logged at info level for local dev.
 *
 * The outbox is process-local on purpose: it is not a queue and is never
 * exposed over HTTP.
 */
import { BRAND, resolveDefaultLanguage } from '@force/shared';
import { config } from '../config';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';
import { ResendService } from './resend.service';
import { EmailService, renderBrandedShell } from './email.service';
import { emailVerificationTemplate } from './email-templates/email-verification';
import { escapeHtml } from './email-templates/_util';

export interface CapturedMail {
  to: string;
  subject: string;
  html: string;
  /** First absolute http(s) link in the body, for tests that follow it. */
  link: string | null;
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
  return config.nodeEnv === 'production' && ResendService.isConfigured();
}

async function deliver(msg: { to: string; subject: string; html: string }): Promise<void> {
  if (shouldReallySend()) {
    await EmailService.sendPlatformRaw({ to: msg.to, subject: msg.subject, html: msg.html });
    return;
  }
  const link = /href="(https?:\/\/[^"]+)"/.exec(msg.html)?.[1]?.replace(/&amp;/g, '&') ?? null;
  outbox.push({ ...msg, link, at: new Date() });
  if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT);
  if (config.nodeEnv === 'production') {
    // Production without a Resend key must be loud, never silently "sent".
    logger.error(
      { to: maskEmail(msg.to), subject: msg.subject },
      '[PLATFORM-MAIL] RESEND_API_KEY missing in production - mail NOT delivered'
    );
  } else {
    logger.info(
      { to: maskEmail(msg.to), subject: msg.subject, link },
      '[PLATFORM-MAIL] captured (not sent outside production)'
    );
  }
}

type Lang = 'en' | 'ar';

export async function sendMerchantVerificationEmail(
  data: { email: string; name: string; verificationUrl: string; expiresInHours: number },
  language?: Lang
): Promise<void> {
  const lang: Lang = language ?? resolveDefaultLanguage(undefined);
  const content = emailVerificationTemplate[lang](data, BRAND.name);
  const html = renderBrandedShell(content, {
    name: BRAND.name,
    nameAr: null,
    logo: null,
    theme: null,
    email: null,
    phone: null,
    address: null,
    defaultLanguage: lang,
  });
  await deliver({
    to: data.email,
    subject: emailVerificationTemplate.subject[lang](data, ''),
    html,
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
    nameAr: null,
    logo: null,
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
