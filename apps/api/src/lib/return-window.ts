/**
 * Return-window gate (sense audit 1, finding 8). The storefront publishes the
 * merchant's `returnWindowDays` (Google markup + /returns page), so the server
 * must enforce the same promise.
 *
 *  - `null`/`undefined` -> the merchant declared nothing: no server-side limit.
 *  - `0`               -> returns not accepted.
 *  - `n > 0`           -> accepted until `deliveredAt + n days` (falls back to
 *                         `updatedAt` for orders delivered before `deliveredAt`
 *                         was recorded).
 */
export type ReturnWindowVerdict =
  | { open: true; closesAt: Date | null }
  | { open: false; reason: 'NOT_ACCEPTED' | 'EXPIRED'; closesAt: Date | null };

const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateReturnWindow(input: {
  returnWindowDays: number | null | undefined;
  deliveredAt: Date | null | undefined;
  updatedAt: Date;
  now?: Date;
}): ReturnWindowVerdict {
  const days = input.returnWindowDays;
  if (days === null || days === undefined) return { open: true, closesAt: null };
  if (days <= 0) return { open: false, reason: 'NOT_ACCEPTED', closesAt: null };

  const start = input.deliveredAt ?? input.updatedAt;
  const closesAt = new Date(start.getTime() + days * DAY_MS);
  const now = input.now ?? new Date();
  return now.getTime() <= closesAt.getTime()
    ? { open: true, closesAt }
    : { open: false, reason: 'EXPIRED', closesAt };
}
