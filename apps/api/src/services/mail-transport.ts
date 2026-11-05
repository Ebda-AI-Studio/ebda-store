/**
 * The one place outbound email leaves the API (G6, Ruling INFRA-CF-1).
 *
 * Cloudflare Email Service through the Workers `send_email` binding (`EMAIL`), no API key.
 * Suppression (hard bounces, spam complaints) is enforced by Cloudflare's own account suppression
 * list: a suppressed recipient makes `send()` throw `E_RECIPIENT_SUPPRESSED`, which is permanent
 * here. (Resend was removed after the switch was verified live; ARCHIVE: git history before G6.)
 *
 * Callers pass a finished message; they never see the provider. `EmailSendError.code` is the
 * provider's machine-readable code (Cloudflare `E_*`, Resend snake_case) and `permanent` says
 * whether a retry can ever help.
 */
import { cfBindings } from '../cf/bindings';
import { deliverableOnly } from '../lib/undeliverable-email';

export interface OutboundMail {
  /** `Name <addr@host>` or a bare address. */
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  /** RFC 8058 List-Unsubscribe / List-Unsubscribe-Post and `X-` headers. */
  headers?: Record<string, string>;
  /**
   * Ignored: Cloudflare has no idempotency key (Resend deduplicated on it for 24 h), so a step that
   * dies between `send()` and its own "sent" mark can send twice (residual, at-least-once).
   */
  idempotencyKey?: string;
}

const PERMANENT_CF_CODES: ReadonlySet<string> = new Set([
  'E_VALIDATION_ERROR',
  'E_FIELD_MISSING',
  'E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
]);

/** Resend's permanent per-message codes (the set the cart-recovery sender already used). */
export class EmailSendError extends Error {
  readonly permanent: boolean;
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`Email send failed: ${message}`);
    this.name = 'EmailSendError';
    this.permanent = PERMANENT_CF_CODES.has(code);
  }
  /** The provider throttled us: wait and retry, never mark the recipient failed. */
  get isRateLimit(): boolean {
    return this.code === 'E_RATE_LIMIT_EXCEEDED' || this.code === 'E_DAILY_LIMIT_EXCEEDED';
  }
}

/** True when a real send can leave this process (the binding is present). */
export function isMailTransportConfigured(): boolean {
  return !!cfBindings()?.EMAIL;
}

/** `Name <a@b.c>` -> { email, name }; a bare address stays a string. CR/LF never survive. */
export function parseAddress(from: string): string | { email: string; name: string } {
  const clean = from.replace(/[\r\n]+/g, ' ').trim();
  const m = /^(.*)<([^<>\s]+)>\s*$/.exec(clean);
  if (!m) return clean;
  const name = m[1].replace(/^\s*"?|"?\s*$/g, '').trim();
  return name ? { email: m[2], name } : m[2];
}

/** The `sendMail` id when every recipient was a reserved-TLD placeholder: nothing left the process. */
export const SKIPPED_UNDELIVERABLE_ID = 'skipped-undeliverable';

export async function sendMail(msg: OutboundMail): Promise<{ id: string }> {
  // EVERY send path ends here, so the reserved-TLD (`.invalid`) recipient filter of Ruling WA-LEGACY-1
  // sits here too: an undeliverable placeholder is dropped and logged, never handed to the provider.
  const recipients = deliverableOnly(msg.to);
  if (recipients.length === 0) return { id: SKIPPED_UNDELIVERABLE_ID };
  const to = Array.isArray(msg.to) ? recipients : recipients[0]!;
  const binding = cfBindings()?.EMAIL;
  if (!binding) throw new EmailSendError('E_NO_BINDING', 'EMAIL send_email binding missing');
  try {
    const res = await binding.send({
      from: parseAddress(msg.from),
      to,
      subject: msg.subject,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.headers && Object.keys(msg.headers).length ? { headers: msg.headers } : {}),
    });
    return { id: res.messageId };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new EmailSendError(e.code ?? 'E_UNKNOWN', e.message ?? 'unknown');
  }
}
