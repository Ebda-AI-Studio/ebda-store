/**
 * Time budget for the identity RPCs that sit on every authenticated request (BE:E-1). Beyond it the request fails 503 instead of
 * hanging while it holds a pooled DB client. Kept out of identity-client.ts so a test that mocks that module still gets the real
 * timeout.
 */
import { AppError } from '../middleware/error-handler';

/** Budget for the two identity RPCs that sit on every authenticated request (BE:E-1). Beyond it the request fails 503, it does not hang. */
export const IDENTITY_LIVE_TIMEOUT_MS = 3_000;

/** Race an identity RPC against a timer (the service binding takes no AbortSignal). Fails CLOSED with 503. */
export async function withIdentityTimeout<T>(
  p: Promise<T>,
  label: string,
  ms: number = IDENTITY_LIVE_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = performance.now();
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(503, 'IDENTITY_UNAVAILABLE', `Sign-in service timed out (${label})`)
            ),
          ms
        );
      }),
    ]);
  } catch (e) {
    // QA-105 diagnostics: say WHICH call failed and how long it took, so a log line can tell a timeout from a binding / D1 error.
    if (e && typeof e === 'object') {
      Object.assign(e, {
        identityCall: label,
        identityElapsedMs: Math.round(performance.now() - start),
        identityBudgetMs: ms,
      });
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The structured, PII-free log fields for a failed identity call (name, call, elapsed vs budget). Never the message of a token or id. */
export function identityFailureFields(err: unknown): Record<string, unknown> {
  const e = (err ?? {}) as {
    name?: string;
    message?: string;
    identityCall?: string;
    identityElapsedMs?: number;
    identityBudgetMs?: number;
  };
  return {
    errName: e.name ?? typeof err,
    call: e.identityCall ?? 'unknown',
    elapsedMs: e.identityElapsedMs,
    budgetMs: e.identityBudgetMs,
    timedOut: /timed out/.test(e.message ?? ''),
  };
}
