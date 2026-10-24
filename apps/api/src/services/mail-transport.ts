/**
 * The one place outbound email leaves the API (G6, Ruling INFRA-CF-1).
 *
 * Provider switch `EMAIL_PROVIDER`:
 *  - `cloudflare` (default): the Workers `send_email` binding (`EMAIL`), no API key. Suppression
 *    (hard bounces, spam complaints) is enforced by Cloudflare's own account suppression list: a
 *    suppressed recipient makes `send()` throw `E_RECIPIENT_SUPPRESSED`, which is permanent here.
 *  - `resend`: the legacy SDK, kept only as the rollback path until the Resend decommission.
 *
 * Callers pass a finished message; they never see the provider. `EmailSendError.code` is the
 * provider's machine-readable code (Cloudflare `E_*`, Resend snake_case) and `permanent` says
 * whether a retry can ever help.
 */
import { config } from '../config';
import { cfBindings } from '../cf/bindings';

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
   * Resend deduplicated on this for 24 h; Cloudflare has no equivalent. On the Cloudflare path it
   * is ignored, so a step that dies between `send()` and its own "sent" mark can send twice
   * (residual, same as the Queues path: at-least-once).
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
const PERMANENT_RESEND_CODES: ReadonlySet<string> = new Set([
  'validation_error',
  'missing_required_field',
  'invalid_from_address',
  'invalid_to',
  'invalid_parameter',
  'invalid_access',
  'restricted_api_key',
  'not_found',
]);

export class EmailSendError extends Error {
  readonly permanent: boolean;
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`Email send failed: ${message}`);
    this.name = 'EmailSendError';
    this.permanent = PERMANENT_CF_CODES.has(code) || PERMANENT_RESEND_CODES.has(code);
  }
  /** The provider throttled us: wait and retry, never mark the recipient failed. */
  get isRateLimit(): boolean {
    return (
      this.code === 'E_RATE_LIMIT_EXCEEDED' ||
      this.code === 'E_DAILY_LIMIT_EXCEEDED' ||
      this.code === 'rate_limit_exceeded'
    );
  }
}

export type EmailProvider = 'cloudflare' | 'resend';

export function emailProvider(): EmailProvider {
  return config.emailProvider;
}

/** True when a real send can leave this process (binding present / key set). */
export function isMailTransportConfigured(): boolean {
  return emailProvider() === 'cloudflare' ? !!cfBindings()?.EMAIL : !!config.resendApiKey;
}

/** Per-store custom sender domains exist only on the legacy provider; Cloudflare sends from ebda.app. */
export function customSenderDomainsSupported(): boolean {
  return emailProvider() === 'resend';
}

/** `Name <a@b.c>` -> { email, name }; a bare address stays a string. CR/LF never survive. */
export function parseAddress(from: string): string | { email: string; name: string } {
  const clean = from.replace(/[\r\n]+/g, ' ').trim();
  const m = /^(.*)<([^<>\s]+)>\s*$/.exec(clean);
  if (!m) return clean;
  const name = m[1].replace(/^\s*"?|"?\s*$/g, '').trim();
  return name ? { email: m[2], name } : m[2];
}

export async function sendMail(msg: OutboundMail): Promise<{ id: string }> {
  return emailProvider() === 'cloudflare' ? sendViaCloudflare(msg) : sendViaResend(msg);
}

async function sendViaCloudflare(msg: OutboundMail): Promise<{ id: string }> {
  const binding = cfBindings()?.EMAIL;
  if (!binding) throw new EmailSendError('E_NO_BINDING', 'EMAIL send_email binding missing');
  try {
    const res = await binding.send({
      from: parseAddress(msg.from),
      to: msg.to,
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

let _resend: import('resend').Resend | null = null;
async function sendViaResend(msg: OutboundMail): Promise<{ id: string }> {
  if (!config.resendApiKey) throw new Error('RESEND_API_KEY not configured');
  if (!_resend) {
    const { Resend } = await import('resend');
    _resend = new Resend(config.resendApiKey);
  }
  const client = _resend;
  type Payload = Parameters<typeof client.emails.send>[0];
  const payload = {
    from: msg.from,
    to: Array.isArray(msg.to) ? msg.to : [msg.to],
    subject: msg.subject,
    ...(msg.html ? { html: msg.html } : {}),
    ...(msg.text ? { text: msg.text } : {}),
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.headers ? { headers: msg.headers } : {}),
  } as unknown as Payload;
  const { data, error } = msg.idempotencyKey
    ? await client.emails.send(payload, { idempotencyKey: msg.idempotencyKey })
    : await client.emails.send(payload);
  if (error || !data)
    throw new EmailSendError(error?.name ?? 'unknown', error?.message ?? 'unknown');
  return { id: data.id };
}
