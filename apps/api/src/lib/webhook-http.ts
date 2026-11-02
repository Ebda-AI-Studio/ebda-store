/**
 * Transport for merchant OUTGOING webhooks (docs/plans/2026-10-21-merchant-webhooks.md).
 *
 * - Signature: `X-Ebda-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. The receiver
 *   recomputes over the RAW body and rejects a timestamp outside WEBHOOK_TOLERANCE_SEC (replay).
 * - SSRF: https only, no IP literals, and the host is resolved AGAIN here on every send and every
 *   address checked (`assertPublicHttpUrl`), so a name that was public at registration and was
 *   re-pointed at 127.0.0.1 / 169.254.169.254 afterwards is refused before any connection.
 *   Residual (Ruling WH-6): the fetch re-resolves the name after our check and neither Node nor
 *   Workers can pin the validated address. Production is bounded (a Worker cannot reach private
 *   ranges); on a Node host a rebinding name can read back up to 200 characters of an internal reply
 *   through the delivery log, so a Node deployment must add an address-pinning dispatcher.
 * - Redirects are NEVER followed (Ruling WH-2): a 3xx is a failed delivery, so a public host cannot
 *   bounce us to a private address.
 * - 10 s timeout; only the first WEBHOOK_RESPONSE_SNIPPET_CHARS of the response body are read.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  WEBHOOK_RESPONSE_SNIPPET_CHARS,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_TOLERANCE_SEC,
  webhookUrlShapeError,
  type WebhookEventType,
} from '@ebda/shared';
import { assertPublicHttpUrl } from './safe-fetch';
import { timedFetch } from './fetch-with-timeout';

const hmacHex = (secret: string, t: number, body: string) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

export function signWebhook(
  secret: string,
  body: string,
  timestampSec = Math.floor(Date.now() / 1000)
): string {
  return `t=${timestampSec},v1=${hmacHex(secret, timestampSec, body)}`;
}

/** Reference verifier (the docs show the same steps). Constant-time compare + replay window. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  opts: { nowSec?: number; toleranceSec?: number } = {}
): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return false;
  const t = Number(m[1]);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? WEBHOOK_TOLERANCE_SEC)) return false;
  const a = Buffer.from(hmacHex(secret, t, body), 'hex');
  const b = Buffer.from(m[2], 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Shape (https, no credentials, no IP literal) + live DNS check. Throws on any block. */
export async function assertWebhookUrl(raw: string): Promise<URL> {
  const shape = webhookUrlShapeError(raw);
  if (shape) throw new Error(`WEBHOOK_URL_BLOCKED: ${shape}`);
  return assertPublicHttpUrl(raw);
}

export interface WebhookPostResult {
  ok: boolean;
  status: number | null;
  snippet: string | null;
  error: string | null;
  durationMs: number;
}

async function readSnippet(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  try {
    while (out.length < WEBHOOK_RESPONSE_SNIPPET_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } catch {
    /* a broken body is not a delivery failure */
  } finally {
    await reader.cancel().catch(() => {});
  }
  // eslint-disable-next-line no-control-regex
  const clean = out
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, WEBHOOK_RESPONSE_SNIPPET_CHARS);
  return clean.length > 0 ? clean : null;
}

export async function postWebhook(args: {
  url: string;
  secret: string;
  body: string;
  eventId: string;
  deliveryId: string;
  eventType: WebhookEventType;
  nowSec?: number;
  fetchImpl?: typeof fetch;
}): Promise<WebhookPostResult> {
  const started = Date.now();
  const done = (r: Omit<WebhookPostResult, 'durationMs'>): WebhookPostResult => ({
    ...r,
    durationMs: Date.now() - started,
  });
  try {
    await assertWebhookUrl(args.url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Never echo resolver detail; the merchant sees a stable reason.
    return done({
      ok: false,
      status: null,
      snippet: null,
      error: `blocked: ${msg.replace(/^(WEBHOOK_URL|SSRF)_BLOCKED:\s*/, '').slice(0, 80)}`,
    });
  }
  const doFetch = args.fetchImpl ?? timedFetch('webhook.deliver');
  try {
    const res = await doFetch(args.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Ebda-Webhooks/1',
        'x-ebda-event': args.eventType,
        'x-ebda-event-id': args.eventId,
        'x-ebda-delivery-id': args.deliveryId,
        'x-ebda-signature': signWebhook(args.secret, args.body, args.nowSec),
      },
      body: args.body,
    });
    const snippet = await readSnippet(res);
    if (res.status >= 300 && res.status < 400) {
      return done({ ok: false, status: res.status, snippet, error: 'redirect_not_followed' });
    }
    const ok = res.status >= 200 && res.status < 300;
    return done({ ok, status: res.status, snippet, error: ok ? null : `http_${res.status}` });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return done({
      ok: false,
      status: null,
      snippet: null,
      error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error',
    });
  }
}
