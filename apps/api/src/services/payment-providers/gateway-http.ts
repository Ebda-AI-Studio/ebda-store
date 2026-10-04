/**
 * Shared plumbing for the Egyptian gateway adapters (SP6b): Paymob, Kashier, Fawry.
 *
 *  - `gatewayRequest`: one bounded HTTP call to a gateway, every failure mapped to a
 *    `PaymentProviderError` so the circuit breaker can tell an outage (timeout,
 *    unreachable, 5xx) from a request the gateway refused (4xx);
 *  - `resolveBaseUrl`: sandbox / live base URL, with the stub override the tests and
 *    the buy-flow parity harness use (honoured only outside production);
 *  - `safeEqual`: constant-time string comparison for signatures;
 *  - `IdempotencyCache`: the adapter-side half of "same key, same result, no second
 *    provider call" (the gateways have no idempotency header);
 *  - `moneyFromGateway`: decimal strings / numbers a gateway sends -> integer
 *    piastres, or `WEBHOOK_MALFORMED`. Integer string math (the region helpers), no
 *    float: `0.29 * 100 = 28.999999999999996` is exactly the defect this prevents.
 */
import crypto from 'node:crypto';
import { toMinor } from '@force/shared';
import { callProvider } from './provider-call';
import {
  PaymentProviderError,
  type PaymentProviderErrorCode,
  type ProviderMode,
  type WebhookHeaders,
} from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GatewayAdapterOptions {
  /** Injected transport (the tests' in-process stub); default: the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Per-call budget; default `PAYMENT_PROVIDER_TIMEOUT_MS` / 10 s. */
  timeoutMs?: number;
  /** Explicit base URLs (tests); beats the env override and the built-in defaults. */
  baseUrls?: Partial<Record<ProviderMode, string>>;
}

export interface BaseUrls {
  sandbox: string;
  live: string;
}

/**
 * Base URL for a mode. `<PROVIDER>_BASE_URL` redirects an adapter to a stub (parity
 * harness, local dev); like the legacy override it is honoured only outside
 * production or with `PAYMENT_PROVIDER_STUB=1`, so it can never redirect real money.
 * It is an ENV setting, never a per-merchant one: a merchant-chosen URL would let a
 * store point the server at an internal address (SSRF).
 */
export function resolveBaseUrl(
  envVar: string,
  defaults: BaseUrls,
  mode: ProviderMode,
  explicit?: GatewayAdapterOptions['baseUrls']
): string {
  const fromOptions = explicit?.[mode];
  if (fromOptions) return fromOptions.replace(/\/+$/, '');
  const override = process.env[envVar]?.trim();
  if (
    override &&
    (process.env.NODE_ENV !== 'production' || process.env.PAYMENT_PROVIDER_STUB === '1')
  ) {
    return override.replace(/\/+$/, '');
  }
  return defaults[mode];
}

const truncate = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);

/**
 * One gateway call. Resolves with the parsed JSON body of a 2xx answer. A 5xx / 429 /
 * transport failure is an OUTAGE; 401/403 is a merchant credential problem
 * (`PROVIDER_MISCONFIGURED`, not an outage); `notFound` maps a 404 (status / refund
 * lookups); any other 4xx is `PROVIDER_REJECTED`. Secrets never reach the message:
 * only the HTTP status and a truncated, gateway-authored reason.
 */
export async function gatewayRequest<T = Record<string, unknown>>(
  op: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  opts: { notFound?: PaymentProviderErrorCode } = {}
): Promise<T> {
  return callProvider(
    op,
    async signal => {
      const res = await fetchImpl(url, { ...init, signal });
      const text = await res.text();
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          if (res.ok) {
            throw new PaymentProviderError(
              'PROVIDER_UNAVAILABLE',
              `${op}: gateway answered ${res.status} with a body that is not JSON`
            );
          }
        }
      }
      if (res.ok) return body as T;
      const reason = gatewayReason(body) ?? text;
      if (res.status === 404 && opts.notFound) {
        throw new PaymentProviderError(opts.notFound, `${op}: not found at the gateway`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new PaymentProviderError(
          'PROVIDER_MISCONFIGURED',
          `${op}: the gateway refused the merchant credentials (HTTP ${res.status})`
        );
      }
      if (res.status >= 500 || res.status === 429 || res.status === 408) {
        throw new PaymentProviderError('PROVIDER_UNAVAILABLE', `${op}: gateway HTTP ${res.status}`);
      }
      throw new PaymentProviderError(
        'PROVIDER_REJECTED',
        `${op}: gateway HTTP ${res.status}${reason ? `: ${truncate(String(reason))}` : ''}`
      );
    },
    timeoutMs
  );
}

function gatewayReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  for (const k of ['message', 'detail', 'error', 'statusDescription', 'description']) {
    const v = b[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** Constant-time comparison of two strings (hashed first so differing lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export function webhookHeader(headers: WebhookHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function rawBodyText(rawBody: string | Buffer): string {
  return typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
}

export function parseJsonBody(rawBody: string | Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBodyText(rawBody));
  } catch {
    throw new PaymentProviderError('WEBHOOK_MALFORMED', 'webhook body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PaymentProviderError('WEBHOOK_MALFORMED', 'webhook body is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * A money value a gateway sent (decimal string or number with at most two decimals,
 * e.g. "123.45", 99.5) -> integer piastres. Anything else is `WEBHOOK_MALFORMED`.
 */
export function moneyFromGateway(value: unknown, what: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PaymentProviderError('WEBHOOK_MALFORMED', `${what} is missing`);
  }
  try {
    // A JS number's shortest decimal repr is what the gateway meant (99.5 -> "99.5").
    return toMinor(typeof value === 'number' ? String(value) : value.trim());
  } catch {
    throw new PaymentProviderError('WEBHOOK_MALFORMED', `${what} is not an EGP amount`);
  }
}

/** An integer-piastre value a gateway sent (Paymob `amount_cents`). */
export function integerPiastres(value: unknown, what: string): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new PaymentProviderError('WEBHOOK_MALFORMED', `${what} is not an integer piastre amount`);
  }
  return n;
}

/**
 * Same key -> same result, with ONE call in flight per key. The gateways have no
 * idempotency header, so this is the adapter's half of the contract; the other half
 * is the caller's: a stable `idempotencyKey` per (order, attempt) and, for refunds,
 * the refund-claim ledger in `PaymentService.refund`. Keys are scoped by a hash of
 * the merchant's credentials so two merchants never share a slot. Bounded and
 * time-limited (a settled entry is dropped after `ttlMs`; a failed call is never
 * remembered, so it can be retried).
 */
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();
  constructor(
    private readonly max = 5_000,
    private readonly ttlMs = 24 * 3_600_000
  ) {}

  async once(scope: string, key: string, run: () => Promise<T>): Promise<T> {
    const id = `${crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16)}:${key}`;
    const hit = this.entries.get(id);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = run();
    this.entries.set(id, { at: Date.now(), value });
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    try {
      return await value;
    } catch (err) {
      if (this.entries.get(id)?.value === value) this.entries.delete(id);
      throw err;
    }
  }
}

/** Scope string for `IdempotencyCache.once`: identifies the merchant account without keeping a secret. */
export function credentialScope(parts: Array<string | undefined>): string {
  return parts.map(p => p ?? '').join('|');
}

/** A stable, short, gateway-safe reference for (order, attempt): `ORD-1042-3fa9c1d2b7`. */
export function merchantReference(orderNumber: string | undefined, idempotencyKey: string): string {
  const tail = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 10);
  const head = (orderNumber ?? 'ORD').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'ORD';
  return `${head}-${tail}`;
}
