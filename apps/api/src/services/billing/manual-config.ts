/**
 * Manual (InstaPay) payment settings, read from the environment at call time
 * (docs/ENVIRONMENT.md). Unset handle = the InstaPay option is not offered and
 * choosing it is refused (fail closed: never show a merchant an empty handle).
 */
import { BRAND, normalizeEgyptianMobile } from '@ebda/shared';

export function instapayHandle(
  env: Record<string, string | undefined> = process.env
): string | null {
  const v = (env.EBDA_INSTAPAY_HANDLE ?? '').trim();
  return v ? v.slice(0, 120) : null;
}

/** wa.me link to Ebda support (EBDA_SUPPORT_WHATSAPP); null when unset. No WhatsApp API is used. */
export function supportWhatsappUrl(
  text?: string,
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = (env.EBDA_SUPPORT_WHATSAPP ?? '').trim();
  if (!raw) return null;
  const digits = normalizeEgyptianMobile(raw)?.slice(1) ?? raw.replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/**
 * Ebda's InstaPay QR image (EBDA_INSTAPAY_QR_URL), shown next to the handle.
 * Only an absolute https URL is accepted; anything else (unset, http, junk) is
 * null so the page shows no QR rather than a broken image.
 */
export function instapayQrUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = (env.EBDA_INSTAPAY_QR_URL ?? '').trim();
  if (!raw || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** Support email (EBDA_SUPPORT_EMAIL); an unset or malformed value falls back to BRAND.supportEmail. */
export function supportEmail(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.EBDA_SUPPORT_EMAIL ?? '').trim();
  return EMAIL.test(raw) ? raw : BRAND.supportEmail;
}

/**
 * How a merchant reaches Ebda about billing. WhatsApp when configured; the
 * email is ALWAYS present, so a surface never renders an empty wa.me link and
 * never has no contact at all (Ruling EBDA-BILLFU-2).
 */
export function supportContact(
  text?: string,
  env: Record<string, string | undefined> = process.env
): { whatsappUrl: string | null; email: string; mailto: string } {
  const email = supportEmail(env);
  const subject = text ? `?subject=${encodeURIComponent(text)}` : '';
  return { whatsappUrl: supportWhatsappUrl(text, env), email, mailto: `mailto:${email}${subject}` };
}
