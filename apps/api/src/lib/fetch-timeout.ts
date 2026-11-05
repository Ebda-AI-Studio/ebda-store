/**
 * Every outbound HTTP call from the API has a deadline (PERF-TIMEOUTS). A provider that accepts the connection and
 * never answers would otherwise hold a Worker invocation (and a checkout, a webhook, a queue message) until the
 * platform kills it. `fetchWithTimeout` is `fetch` plus a default deadline and a per-call override:
 *
 *   await fetchWithTimeout(url, init)                          // DEFAULT_FETCH_TIMEOUT_MS
 *   await fetchWithTimeout(url, { ...init, timeoutMs: 60_000 }) // slow LLM call
 *
 * A caller-supplied `signal` still works: the call aborts on whichever fires first. On timeout the promise rejects
 * with a `TimeoutError` (name), the same error `AbortSignal.timeout` raises.
 * `tests/unit/external-fetch-has-timeout.test.ts` fails a bare `fetch(` in `apps/api/src`.
 */

/** A generic provider call (REST, webhooks, OAuth token exchange). */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
/** A generative-model call: seconds to tens of seconds is normal. */
export const LLM_FETCH_TIMEOUT_MS = 60_000;

export type TimedRequestInit = RequestInit & {
  /** Override the default deadline for this call, in milliseconds. */
  timeoutMs?: number;
};

export function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: TimedRequestInit = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal, ...rest } = init;
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, { ...rest, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
}
