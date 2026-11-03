/**
 * P0 logout audit: renew the short-lived access token ~60 s BEFORE it expires so parallel requests never stampede into
 * 401s. Single-flight across tabs via the Web Locks API (`ifAvailable`): the tab that gets the lock refreshes, and the
 * shared cookie it renews serves every other tab. The reactive refresh-on-401 in api.ts stays as the fallback.
 */
export const PROACTIVE_LEAD_MS = 60_000;

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

/** `expiresAtMs` is the token's expiry as epoch milliseconds. */
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
  const delay = Math.max(0, expiresAtMs - PROACTIVE_LEAD_MS - Date.now());
  timer = setTimeout(run, delay);
  if (typeof document !== 'undefined') {
    // Background tabs throttle timers: catch up the moment the tab is visible again and the token is due.
    visibilityHandler = () => {
      if (document.visibilityState === 'visible' && Date.now() >= expiresAtMs - PROACTIVE_LEAD_MS) {
        run();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
}

/** Epoch ms when a grant expires: its `expires_at` (seconds or ms), else the JWT `exp`, else a 4-minute guess. */
export function grantExpiryMs(grant: { access_token?: string; expires_at?: number }): number {
  const norm = (n: number) => (n < 1e12 ? n * 1000 : n);
  if (
    typeof grant.expires_at === 'number' &&
    Number.isFinite(grant.expires_at) &&
    grant.expires_at > 0
  ) {
    return norm(grant.expires_at);
  }
  try {
    const payload = JSON.parse(
      atob((grant.access_token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    if (typeof payload.exp === 'number') return norm(payload.exp);
  } catch {
    // not a JWT we can read
  }
  return Date.now() + 4 * 60_000;
}
