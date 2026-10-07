/**
 * Manual (InstaPay) payment settings, read from the environment at call time
 * (docs/ENVIRONMENT.md). Unset handle = the InstaPay option is not offered and
 * choosing it is refused (fail closed: never show a merchant an empty handle).
 */
import { normalizeEgyptianMobile } from '@force/shared';

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
