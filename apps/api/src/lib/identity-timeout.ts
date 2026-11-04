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
