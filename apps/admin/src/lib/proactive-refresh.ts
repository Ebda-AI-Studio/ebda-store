/**
 * P0 logout audit: renew the short-lived access token ~60 s BEFORE it expires so parallel requests never stampede into
 * 401s. Single-flight across tabs via the Web Locks API (`ifAvailable`): the tab that gets the lock refreshes, and the
 * shared cookie it renews serves every other tab. The reactive refresh-on-401 in api.ts stays as the fallback.
 */
export const PROACTIVE_LEAD_MS = 60_000;
/**
 * Never refresh sooner than this after arming. A short-lived token, or a device clock far ahead of the server's, used to
 * give a delay of 0: each refresh re-armed an immediate refresh and the tab hammered accounts until it throttled.
 */
export const PROACTIVE_MIN_DELAY_MS = 30_000;

export interface ProactiveDeps {
  refresh: () => Promise<unknown>;
  /** Runs `fn` only if this tab wins the cross-tab lock; resolves without running it otherwise. */
  withLock: (fn: () => Promise<void>) => Promise<void>;
}

const webLock: ProactiveDeps['withLock'] = async fn => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  await locks.request('ebda-token-refresh', { ifAvailable: true }, async lock => {
    if (lock) await fn();
  });
};

let timer: ReturnType<typeof setTimeout> | undefined;
let visibilityHandler: (() => void) | undefined;

export function disarmProactiveRefresh(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = undefined;
}

/** `expiresAtMs` is the token's expiry as epoch milliseconds ON THIS DEVICE'S CLOCK (see `grantExpiryMs`). */
export function armProactiveRefresh(
  expiresAtMs: number,
  deps: Partial<ProactiveDeps> & Pick<ProactiveDeps, 'refresh'>
): void {
  disarmProactiveRefresh();
  const withLock = deps.withLock ?? webLock;
  const run = () =>
    withLock(async () => {
      await deps.refresh();
    }).catch(() => {
      // A failed proactive refresh is not a sign-out: the reactive refresh on the next 401 decides.
    });
  const delay = Math.max(PROACTIVE_MIN_DELAY_MS, expiresAtMs - PROACTIVE_LEAD_MS - Date.now());
  const dueAtMs = Date.now() + delay;
  timer = setTimeout(run, delay);
  if (typeof document !== 'undefined') {
    // Background tabs throttle timers: catch up the moment the tab is visible again and the token is due.
    visibilityHandler = () => {
      if (document.visibilityState === 'visible' && Date.now() >= dueAtMs) {
        run();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
}

/**
 * Epoch ms, on THIS device's clock, when a grant expires. Computed from the token's LIFETIME relative to the moment it was
 * received (JWT `exp - iat`, which does not depend on the device clock), never `exp - Date.now()`: a skewed device clock made
 * that difference zero or negative forever. Without a readable JWT it falls back to the server's `expires_at` clamped to a sane
 * lifetime, else 4 minutes. `armProactiveRefresh` additionally enforces PROACTIVE_MIN_DELAY_MS.
 */
export function grantExpiryMs(grant: { access_token?: string; expires_at?: number }): number {
  const norm = (n: number) => (n < 1e12 ? n * 1000 : n);
  const now = Date.now();
  try {
    const payload = JSON.parse(
      atob((grant.access_token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    if (typeof payload.exp === 'number' && typeof payload.iat === 'number') {
      const life = norm(payload.exp) - norm(payload.iat);
      if (life > 0) return now + life;
    }
  } catch {
    // not a JWT we can read
  }
  if (
    typeof grant.expires_at === 'number' &&
    Number.isFinite(grant.expires_at) &&
    grant.expires_at > 0
  ) {
    const remaining = norm(grant.expires_at) - now;
    // Clock-skew guard: a non-positive or absurd remainder says the clocks disagree, not that the token lives that long.
    if (remaining > PROACTIVE_LEAD_MS && remaining <= 24 * 3_600_000) return now + remaining;
  }
  return now + 4 * 60_000;
}
