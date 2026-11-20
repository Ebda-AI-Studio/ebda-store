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
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * True when an identity RPC failed BECAUSE the session or account is expired / revoked / unknown (the service replied),
 * as opposed to our own timeout (an AppError 503) or a network / 5xx failure (anything else). Only a message that names
 * the session or token state counts; an unrecognised error stays an outage (fail closed, never log users out on a guess).
 */
export function isDeadSessionError(err: unknown): boolean {
  if (err instanceof AppError) return false;
  const msg = err instanceof Error ? err.message : '';
  if (/\b(timed? ?out|network|fetch failed|unavailable|5\d\d|binding)\b/i.test(msg)) return false;
  return /\b(session|token|account|user)\b.*\b(expired|revoked|invalid|not found|unknown|deleted)\b|\b(expired|revoked)\b.*\b(session|token)\b/i.test(
    msg
  );
}
