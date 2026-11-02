/**
 * Ruling PERF-TIMEOUTS-1 (SCALE-READY #6): every outbound HTTP call from apps/api to a third party goes through THIS
 * helper, so no request can hold a Worker/queue slot open forever on a stalled upstream. A raw `fetch(` anywhere else
 * under apps/api/src fails `tests/unit/api-no-raw-fetch.test.ts`.
 *
 * Defaults by class: `payment` 10 s (gateways, couriers' money calls), `ai` 30 s (model/embedding calls), `default`
 * 8 s (everything else). The timer covers the headers AND the body read (the signal stays attached until the body is
 * consumed). A caller's own `signal` is honoured: whichever fires first wins.
 *
 * On timeout it throws `FetchTimeoutError` (`name === 'TimeoutError'`, same as the platform's own
 * `AbortSignal.timeout` rejection, so existing `catch` blocks and `err.name` checks keep working) and logs the label and
 * limit only: never the URL, headers or body (they carry tokens and customer PII). Callers keep their failure
 * behaviour: a thrown error is what a network failure already was.
 *
 * Streaming responses (SSE) are exempt from the total limit by passing `timeoutMs: 0` AND a `idleMs`; the idle timer
 * resets on each chunk (`withIdleTimeout`). No call site streams today; the exemption exists so the first one does not
 * have to bypass the helper.
 */
import logger from './logger';

export type FetchClass = 'payment' | 'ai' | 'default';

export const FETCH_TIMEOUT_MS: Readonly<Record<FetchClass, number>> = {
  payment: 10_000,
  ai: 30_000,
  default: 8_000,
};

export interface FetchTimeoutOptions {
  /** Short, stable, PII-free name of the call (`onesignal.send`, `paymob.auth`); logged on timeout. */
  label: string;
  class?: FetchClass;
  /** Overrides the class default. `0` disables the total limit (streaming only; pair with `idleMs`). */
  timeoutMs?: number;
}

export class FetchTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchWithTimeout(
  url: string | URL | Request,
  init: RequestInit | undefined,
  opts: FetchTimeoutOptions,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const ms = opts.timeoutMs ?? FETCH_TIMEOUT_MS[opts.class ?? 'default'];
  if (ms <= 0) return fetchImpl(url, init);
  const timeout = AbortSignal.timeout(ms);
  const caller = init?.signal ?? undefined;
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (timeout.aborted && !caller?.aborted) {
      logger.warn({ label: opts.label, timeoutMs: ms }, 'outbound fetch timed out');
      throw new FetchTimeoutError(opts.label, ms);
    }
    throw err;
  }
}

/**
 * A `fetch`-shaped function with the timeout baked in, for places that take an injected transport
 * (`fetchImpl ?? timedFetch(...)`) or call `fetch(url, init)` and should read the same afterwards.
 */
export function timedFetch(
  label: string,
  cls: FetchClass = 'default',
  timeoutMs?: number
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    fetchWithTimeout(url, init, { label, class: cls, timeoutMs })) as typeof fetch;
}

/** Aborts `controller` when no chunk arrived for `idleMs`; call the returned `touch()` on every chunk. */
export function withIdleTimeout(controller: AbortController, idleMs: number, label: string) {
  let timer = setTimeout(fire, idleMs);
  function fire() {
    logger.warn({ label, idleMs }, 'outbound stream idle timeout');
    controller.abort(new FetchTimeoutError(label, idleMs));
  }
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(fire, idleMs);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
