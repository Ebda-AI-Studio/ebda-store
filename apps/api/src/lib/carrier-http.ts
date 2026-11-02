/**
 * Shared plumbing for the Egypt shipping-carrier adapters (SP7): Bosta, Aramex.
 *
 *  - `resolveCarrierBaseUrl`: sandbox / live base URL, with the stub override the tests and
 *    local development use (honoured only outside production or with `CARRIER_STUB=1`).
 *    It is an ENV setting, never a per-merchant one: a merchant-chosen URL would let a
 *    store point the server at an internal address (SSRF), which is why the adapters
 *    take no URL from the stored credentials.
 *  - `carrierRequest`: one bounded HTTP call, every failure mapped to a `CarrierError`
 *    so the shipment-creation job can tell an outage (retry) from a refusal (do not).
 *    Real hosts go through `safeFetch` (resolve-and-block, manual redirects); only the stub
 *    override uses the global `fetch`, because the guard refuses loopback by design.
 *  - `safeEqual`: constant-time comparison for URL secrets.
 */
import crypto from 'node:crypto';
import { safeFetch } from './safe-fetch';
import { CarrierError } from '../services/carriers/types';
import { timedFetch } from './fetch-with-timeout';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CarrierHttpOptions {
  /** Injected transport (tests); default: `safeFetch`, or the global `fetch` for a stub base URL. */
  fetchImpl?: FetchLike;
  /** Per-call budget; default `CARRIER_CALL_TIMEOUT_MS` / 10 s. */
  timeoutMs?: number;
  /** Explicit base URL (tests); beats the env override and the built-in defaults. */
  baseUrl?: string;
}

export const DEFAULT_CARRIER_TIMEOUT_MS = 10_000;
const timeoutMs = (): number =>
  Number(process.env.CARRIER_CALL_TIMEOUT_MS) || DEFAULT_CARRIER_TIMEOUT_MS;

export interface ResolvedBase {
  url: string;
  /** True when the URL is a local stub (not a real carrier host). */
  stubbed: boolean;
}

export function resolveCarrierBaseUrl(
  envVar: string,
  defaults: { sandbox: string; live: string },
  sandbox: boolean,
  explicit?: string
): ResolvedBase {
  if (explicit) return { url: explicit.replace(/\/+$/, ''), stubbed: true };
  const override = process.env[envVar]?.trim();
  if (override && (process.env.NODE_ENV !== 'production' || process.env.CARRIER_STUB === '1')) {
    return { url: override.replace(/\/+$/, ''), stubbed: true };
  }
  return { url: sandbox ? defaults.sandbox : defaults.live, stubbed: false };
}

export interface CarrierResponse<T = unknown> {
  status: number;
  body: T;
  text: string;
}

const truncate = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);

/**
 * One carrier call. A 2xx resolves; a 5xx / 429 / transport failure is an OUTAGE
 * (`CARRIER_UNAVAILABLE`); 401/403 is a merchant credential problem; any other 4xx is a
 * refusal. `acceptStatus` lets a caller treat chosen statuses (404 on a lookup, 409 on a
 * duplicate) as data instead of failure. Secrets never reach the message.
 */
export async function carrierRequest<T = Record<string, unknown>>(
  op: string,
  base: ResolvedBase,
  path: string,
  init: RequestInit,
  opts: CarrierHttpOptions & { acceptStatus?: number[] } = {}
): Promise<CarrierResponse<T>> {
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? (base.stubbed ? timedFetch('carrier.stub') : safeFetch);
  const ms = opts.timeoutMs ?? timeoutMs();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced, not just aborted: a transport that ignores the signal must still time out.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new CarrierError('CARRIER_UNAVAILABLE', `${op} timed out after ${ms}ms`));
    }, ms);
  });
  let res: Response;
  let text: string;
  try {
    const done = (async () => {
      const r = await fetchImpl(`${base.url}${path}`, { ...init, signal: ctrl.signal });
      return { r, t: await r.text() };
    })();
    done.catch(() => undefined); // a late rejection after the timeout must not go unhandled
    const out = await Promise.race([done, timeout]);
    res = out.r;
    text = out.t;
  } catch (err) {
    if (err instanceof CarrierError) throw err;
    throw new CarrierError(
      'CARRIER_UNAVAILABLE',
      `${op} failed: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
      if (res.ok && !opts.acceptStatus?.includes(res.status)) {
        // a 2xx that is not JSON is the carrier's gateway talking, not an answer
        throw new CarrierError(
          'CARRIER_UNAVAILABLE',
          `${op}: carrier answered ${res.status} with a body that is not JSON`
        );
      }
    }
  }
  if (res.ok || opts.acceptStatus?.includes(res.status)) {
    return { status: res.status, body: body as T, text };
  }
  if (res.status === 401 || res.status === 403) {
    throw new CarrierError(
      'CARRIER_MISCONFIGURED',
      `${op}: the carrier refused the merchant credentials (HTTP ${res.status})`
    );
  }
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    throw new CarrierError('CARRIER_UNAVAILABLE', `${op}: carrier HTTP ${res.status}`);
  }
  const reason =
    body && typeof body === 'object'
      ? ((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error)
      : undefined;
  throw new CarrierError(
    'CARRIER_REJECTED',
    `${op}: carrier HTTP ${res.status}${typeof reason === 'string' && reason ? `: ${truncate(reason)}` : ''}`
  );
}

/** Constant-time comparison of two strings (hashed first so differing lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Integer piastres -> the decimal EGP number carriers want ("123.45"-equivalent), no float math. */
export function piastresToEgp(piastres: number): number {
  if (!Number.isSafeInteger(piastres) || piastres < 0) {
    throw new CarrierError('CARRIER_REJECTED', `amount must be a non-negative integer of piastres`);
  }
  const whole = Math.trunc(piastres / 100);
  const frac = piastres % 100;
  // build from the decimal string: 29 piastres is 0.29, not 0.29000000000000004
  return Number(`${whole}.${String(frac).padStart(2, '0')}`);
}

/** The inverse, from a carrier's decimal EGP number or string, rejecting fractions of a piastre. */
export function egpToPiastres(value: number | string): number {
  const s = typeof value === 'number' ? String(value) : value.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new CarrierError('CARRIER_REJECTED', `not a valid EGP amount: ${s}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/**
 * Like `carrierRequest`, for an endpoint that answers BINARY (a PDF label): same timeout race,
 * same transport choice, same failure mapping, but the body comes back as raw bytes, never
 * decoded as text. A non-2xx never echoes the body into the message.
 */
export async function carrierRequestBinary(
  op: string,
  base: ResolvedBase,
  path: string,
  init: RequestInit,
  opts: CarrierHttpOptions & { acceptStatus?: number[] } = {}
): Promise<{ status: number; bytes: Buffer }> {
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? (base.stubbed ? timedFetch('carrier.stub') : safeFetch);
  const ms = opts.timeoutMs ?? timeoutMs();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new CarrierError('CARRIER_UNAVAILABLE', `${op} timed out after ${ms}ms`));
    }, ms);
  });
  let status: number;
  let ok: boolean;
  let bytes: Buffer;
  try {
    const done = (async () => {
      const r = await fetchImpl(`${base.url}${path}`, { ...init, signal: ctrl.signal });
      return { status: r.status, ok: r.ok, bytes: Buffer.from(await r.arrayBuffer()) };
    })();
    done.catch(() => undefined);
    const out = await Promise.race([done, timeout]);
    status = out.status;
    ok = out.ok;
    bytes = out.bytes;
  } catch (err) {
    if (err instanceof CarrierError) throw err;
    throw new CarrierError(
      'CARRIER_UNAVAILABLE',
      `${op} failed: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (ok || opts.acceptStatus?.includes(status)) return { status, bytes };
  if (status === 401 || status === 403) {
    throw new CarrierError(
      'CARRIER_MISCONFIGURED',
      `${op}: the carrier refused the merchant credentials (HTTP ${status})`
    );
  }
  if (status >= 500 || status === 429 || status === 408) {
    throw new CarrierError('CARRIER_UNAVAILABLE', `${op}: carrier HTTP ${status}`);
  }
  throw new CarrierError('CARRIER_REJECTED', `${op}: carrier HTTP ${status}`);
}

/**
 * Like `carrierRequest`, for an endpoint that answers TEXT that is not JSON (Aramex SOAP/XML):
 * same timeout race, same transport choice, same 401/403 / 5xx / 429 / 4xx mapping, but the body
 * comes back verbatim as `text`. `acceptStatus` lets the caller read a body it must interpret
 * itself (a SOAP Fault arrives as HTTP 500). A non-accepted status never echoes the body.
 */
export async function carrierRequestText(
  op: string,
  base: ResolvedBase,
  path: string,
  init: RequestInit,
  opts: CarrierHttpOptions & { acceptStatus?: number[] } = {}
): Promise<{ status: number; text: string }> {
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? (base.stubbed ? timedFetch('carrier.stub') : safeFetch);
  const ms = opts.timeoutMs ?? timeoutMs();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new CarrierError('CARRIER_UNAVAILABLE', `${op} timed out after ${ms}ms`));
    }, ms);
  });
  let status: number;
  let ok: boolean;
  let text: string;
  try {
    const done = (async () => {
      const r = await fetchImpl(`${base.url}${path}`, { ...init, signal: ctrl.signal });
      return { status: r.status, ok: r.ok, text: await r.text() };
    })();
    done.catch(() => undefined);
    const out = await Promise.race([done, timeout]);
    status = out.status;
    ok = out.ok;
    text = out.text;
  } catch (err) {
    if (err instanceof CarrierError) throw err;
    throw new CarrierError(
      'CARRIER_UNAVAILABLE',
      `${op} failed: ${err instanceof Error ? err.message : 'unknown error'}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (ok || opts.acceptStatus?.includes(status)) return { status, text };
  if (status === 401 || status === 403) {
    throw new CarrierError(
      'CARRIER_MISCONFIGURED',
      `${op}: the carrier refused the merchant credentials (HTTP ${status})`
    );
  }
  if (status >= 500 || status === 429 || status === 408) {
    throw new CarrierError('CARRIER_UNAVAILABLE', `${op}: carrier HTTP ${status}`);
  }
  throw new CarrierError('CARRIER_REJECTED', `${op}: carrier HTTP ${status}`);
}
