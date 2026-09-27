/**
 * A 429 on `/auth/refresh` is not a sign-out.
 *
 * Both clients read the refresh response as `if (!res.ok) return null`, which
 * collapses two opposite facts about a session — "slow down" and "you are
 * signed out" — into the second. In the admin app that answer was destructive:
 * the failed-refresh branch deletes `accessToken` AND `refreshToken` from
 * localStorage, and on the iOS PWA that store holds the ONLY copy of the
 * refresh token. A few seconds of rate-limit back-pressure after a deploy
 * therefore signed the user out permanently, with nothing left to recover
 * from.
 *
 * These tests drive the real client functions against a stubbed fetch. The
 * server-side bucket fix removes the trigger; this is the half that makes the
 * client survive one anyway.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * A localStorage stand-in, built here rather than by switching the file to the
 * jsdom environment: jsdom is not a dependency of this repo (no test uses it),
 * and the per-file environment pragma for it makes vitest try to resolve it
 * mid-run and hang. (Do not write that pragma's literal text anywhere in this
 * file, comments included — vitest scans for it and will switch the
 * environment on the strength of a sentence describing it.) The
 * clients only ever call getItem/setItem/removeItem, and the destructive
 * behaviour under test is a removeItem — which this records faithfully.
 */
function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

const store = makeLocalStorage();
vi.stubGlobal('localStorage', store);
vi.stubGlobal('window', { localStorage: store, navigator: { userAgent: 'node' } });

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
    clone() {
      return this;
    },
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('accessToken', 'stale-access');
  localStorage.setItem('refreshToken', 'the-only-copy');
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('admin client — a throttled refresh keeps the credentials', () => {
  it('throws RefreshThrottledError instead of reporting a dead session', async () => {
    globalThis.fetch = vi.fn(async () => res(429, {}, { 'Retry-After': '12' })) as never;
    const { refreshAccessToken, RefreshThrottledError } = await import('@admin/lib/api');

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(RefreshThrottledError);
  });

  // NOTE: there is deliberately no `Retry-After` assertion here. An earlier
  // version of this suite had one, asserting 12 against a hand-stubbed
  // `headers.get` — a value production cannot produce. The API and all three
  // frontends are on different hosts, so every refresh is cross-origin, and
  // `Retry-After` is not a CORS-safelisted response header: the browser
  // returns null for it regardless of what the server sent. The field was
  // removed rather than papered over with an `exposedHeaders` entry nothing
  // reads; see Ruling P2-B2-4.

  it('still returns null — not a throw — on a genuine 401', async () => {
    // The negative control. Without it, a client that threw on EVERY failure
    // would pass the tests above while breaking real sign-out detection.
    globalThis.fetch = vi.fn(async () => res(401, {})) as never;
    const { refreshAccessToken } = await import('@admin/lib/api');

    await expect(refreshAccessToken()).resolves.toBeNull();
  });

  it('names a throttle as its own outcome, not as a rejection', async () => {
    // This is the decision that used to be spelled `return false`, one line
    // above a localStorage wipe.
    globalThis.fetch = vi.fn(async () => res(429)) as never;
    const { refreshSession } = await import('@admin/lib/api');

    await expect(refreshSession()).resolves.toBe('throttled');
  });

  it('still names a 401 a rejection — the outcome that DOES end the session', async () => {
    globalThis.fetch = vi.fn(async () => res(401, {})) as never;
    const { refreshSession } = await import('@admin/lib/api');

    await expect(refreshSession()).resolves.toBe('rejected');
  });

  it('clearStoredSession is what ends it, and a throttle never reaches it', async () => {
    // The destructive step, isolated: on the iOS PWA `refreshToken` in
    // localStorage is the only copy of the credential. checkAuth calls this
    // for 'rejected' and for a failed retry — never for 'throttled'.
    globalThis.fetch = vi.fn(async () => res(429)) as never;
    const { refreshSession, clearStoredSession } = await import('@admin/lib/api');

    expect(await refreshSession()).toBe('throttled');
    expect(localStorage.getItem('refreshToken')).toBe('the-only-copy');

    clearStoredSession();
    expect(localStorage.getItem('refreshToken')).toBeNull();
  });

  it('does not let a throttle escape apiRequest into product code', async () => {
    // apiRequest's 401-retry must degrade to "no retry", not reject: a throw
    // here would surface as an unhandled error in every admin screen.
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh') ? res(429) : res(401, { success: false })
    ) as never;
    const { apiRequest } = await import('@admin/lib/api');

    await expect(apiRequest('/orders')).resolves.toBeTruthy();
  });
});

/**
 * The THIRD frontend.
 *
 * The first version of this fix landed on admin and web and left
 * `apps/orders` byte-identical to the bug — same `if (!res.ok) return null`,
 * same blanket catch, same `localStorage.removeItem` pair in its checkAuth.
 * orders is a deployed PWA (orders.force-ai.co) that asks for persistent
 * storage precisely to keep the one copy of that credential alive, and the
 * refresh bucket is per USER — so the orders PWA, the admin PWA and every
 * browser tab for the same merchant share ONE budget. When it is exhausted,
 * admin survives and orders performs the unrecoverable wipe. A client-side
 * auth fix on two of three surfaces is not a fix.
 */
describe('orders client — the third frontend gets the same answer', () => {
  it('throws RefreshThrottledError instead of reporting a dead session', async () => {
    globalThis.fetch = vi.fn(async () => res(429)) as never;
    const { refreshAccessToken, RefreshThrottledError } = await import('@orders/lib/api');

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(RefreshThrottledError);
  });

  it('names a throttle as its own outcome, not as a rejection', async () => {
    globalThis.fetch = vi.fn(async () => res(429)) as never;
    const { refreshSession } = await import('@orders/lib/api');

    await expect(refreshSession()).resolves.toBe('throttled');
  });

  it('still names a 401 a rejection — the outcome that DOES end the session', async () => {
    globalThis.fetch = vi.fn(async () => res(401, {})) as never;
    const { refreshSession } = await import('@orders/lib/api');

    await expect(refreshSession()).resolves.toBe('rejected');
  });

  it('leaves the only copy of the credential in place on a throttle', async () => {
    globalThis.fetch = vi.fn(async () => res(429)) as never;
    const { refreshSession, clearStoredSession } = await import('@orders/lib/api');

    expect(await refreshSession()).toBe('throttled');
    expect(localStorage.getItem('refreshToken')).toBe('the-only-copy');

    clearStoredSession();
    expect(localStorage.getItem('refreshToken')).toBeNull();
  });

  it('does not let a throttle escape apiRequest into product code', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh') ? res(429) : res(401, { success: false })
    ) as never;
    const { apiRequest } = await import('@orders/lib/api');

    await expect(apiRequest('/orders')).resolves.toBeTruthy();
  });
});

describe('web client — a throttled refresh is not a rejected request', () => {
  // NOTE the endpoint. `request()` skips the refresh-retry entirely for
  // anything under `/auth/`, so driving this through `getProfile()`
  // (`/auth/me`) would exercise no refresh at all and pass for the wrong
  // reason. A cart read is a real storefront call that does take the path.
  it('reports RATE_LIMITED rather than the bare 401 it could not refresh', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh') ? res(429) : res(401, { success: false })
    ) as never;
    const { api } = await import('@web/lib/api');

    const result = await api.getCart();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RATE_LIMITED');
  });

  it('still reports the original failure when the refresh was genuinely rejected', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh')
        ? res(401, { success: false })
        : res(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } })
    ) as never;
    const { api } = await import('@web/lib/api');

    const result = await api.getCart();

    expect(result.success).toBe(false);
    expect(result.error?.code).not.toBe('RATE_LIMITED');
  });
});

/**
 * #1789: `/auth/me` was folded into the blanket `/auth/` refresh-skip, so
 * `AuthContext.refreshUser` (which calls exactly `getProfile()`, i.e.
 * `/auth/me`) could NEVER take the refresh path — a signed-in customer past
 * the 30-minute access-token window was rendered a guest with a perfectly
 * valid 365-day refresh token sitting unused in the refresh_token cookie.
 * `/auth/refresh` itself stays excluded from the retry (its own 401/429
 * handling is the raw `fetch` inside `refreshAccessToken()`, never a
 * recursive call through `request()`), so exempting more than that one route
 * carries no loop risk.
 */
describe('web client — /auth/me specifically now takes the refresh-retry path (#1789)', () => {
  it('getProfile() silently refreshes and returns the profile instead of reporting a dead session', async () => {
    let meCalls = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) {
        return res(200, { success: true, data: { refreshed: true, csrfToken: 'c' } });
      }
      meCalls += 1;
      return meCalls === 1
        ? res(401, { success: false })
        : res(200, { success: true, data: { user: { id: 'u1', role: 'customer' } } });
    }) as never;
    const { api } = await import('@web/lib/api');

    const result = await api.getProfile();

    expect(result.success).toBe(true);
    expect(result.data?.user).toEqual({ id: 'u1', role: 'customer' });
    // The 401 THEN the retried 200 — proves a refresh actually happened
    // in between rather than /auth/me being answered once and cached.
    expect(meCalls).toBe(2);
  });

  it('reports RATE_LIMITED for /auth/me too — a throttle is not a sign-out here either', async () => {
    globalThis.fetch = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh') ? res(429) : res(401, { success: false })
    ) as never;
    const { api } = await import('@web/lib/api');

    const result = await api.getProfile();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RATE_LIMITED');
  });
});

/**
 * Preserving the credential was only HALF an answer.
 *
 * On the mount path, `'throttled'` left the provider unauthenticated:
 * `setUser` was never called, `isLoading` went false, and the redirect effect
 * pushed the user to /login. `checkAuth` runs once — guarded by a ref, with a
 * deliberately empty dependency array — so "the next request retries" was not
 * true there; nothing ever re-exercised the surviving token. The user still
 * met a password prompt while holding a perfectly good session; only the
 * localStorage entry survived.
 *
 * So the wait happens INSIDE the refresh, where `isLoading` is still true and
 * the redirect cannot fire. This suite drives that loop on fake timers.
 */
describe.each([
  ['admin', () => import('@admin/lib/api')],
  ['orders', () => import('@orders/lib/api')],
])('%s client — a throttle is waited out, not reported as a sign-out', (_name, load) => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries past a transient throttle and reports the eventual success', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () =>
      ++call === 1 ? res(429) : res(200, { success: true, data: { refreshed: true } })
    ) as never;
    const { refreshSessionWaitingOutThrottle } = await load();

    const pending = refreshSessionWaitingOutThrottle();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toBe('refreshed');
    expect(call).toBeGreaterThan(1);
  });

  it('gives up after a bounded number of attempts rather than hanging', async () => {
    globalThis.fetch = vi.fn(async () => res(429)) as never;
    const { refreshSessionWaitingOutThrottle, THROTTLE_RETRY_DELAYS_MS } = await load();

    const pending = refreshSessionWaitingOutThrottle();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toBe('throttled');
    // One initial attempt plus one per delay — no more, or a throttled app
    // hammers the bucket it is already over.
    expect(globalThis.fetch).toHaveBeenCalledTimes(THROTTLE_RETRY_DELAYS_MS.length + 1);
  });

  it('does not wait at all when the first answer is decisive', async () => {
    // The negative control: a 401 must come back immediately. A loop that
    // slept on every outcome would delay every genuine sign-out by seconds.
    globalThis.fetch = vi.fn(async () => res(401, {})) as never;
    const { refreshSessionWaitingOutThrottle } = await load();

    await expect(refreshSessionWaitingOutThrottle()).resolves.toBe('rejected');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * #1782 / #1814. Preserving the credential (above) was only half the answer:
 * `checkAuth` ran the /auth/me + refresh sequence ONCE per mount, and
 * `refreshSessionWaitingOutThrottle`'s own ladder is deliberately ONE 1.5s
 * retry (Ruling P2-B2-7) — not a recovery from a real throttle by itself. So
 * a throttle that would have cleared within seconds still left `isLoading`
 * false and `user` null, and the redirect effect routed straight to /login.
 *
 * `checkSessionWithMountRetries` wraps the whole /auth/me-plus-refresh check
 * in a further bounded ladder (`MOUNT_RETRY_DELAYS_MS`) at the mount-check
 * layer, so `isLoading` stays true — and the redirect cannot fire — for a
 * few more attempts before the caller gives up.
 */
describe.each([
  ['admin', () => import('@admin/lib/api')],
  ['orders', () => import('@orders/lib/api')],
])(
  '%s client — the mount-time session check outlasts a transient throttle (#1782)',
  (_name, load) => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('recovers via the OUTER (mount-level) retry even when the inner refresh ladder alone would still be throttled', async () => {
      let refreshCalls = 0;
      globalThis.fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes('/auth/refresh')) {
          refreshCalls += 1;
          // The inner ladder (refreshSessionWaitingOutThrottle) makes exactly
          // 2 attempts per call on its own (1 + THROTTLE_RETRY_DELAYS_MS.length
          // = 1 + 1). Succeeding only on the 3rd attempt overall means recovery
          // is IMPOSSIBLE unless checkSession is invoked a second time by the
          // outer, mount-level ladder.
          return refreshCalls >= 3
            ? res(200, { success: true, data: { refreshed: true } })
            : res(429);
        }
        // /auth/me: 401 until a refresh has actually succeeded.
        return refreshCalls >= 3 ? res(200, { data: { user: { id: 'u1' } } }) : res(401, {});
      }) as never;
      const { checkSessionWithMountRetries } = await load();

      const pending = checkSessionWithMountRetries('http://test/api/v1');
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({ status: 'authenticated', user: { id: 'u1' } });
      expect(refreshCalls).toBeGreaterThanOrEqual(3);
    });

    it('gives up after a bounded budget rather than hanging when the throttle never clears', async () => {
      globalThis.fetch = vi.fn(async (url: unknown) =>
        String(url).includes('/auth/refresh') ? res(429) : res(401, {})
      ) as never;
      const { checkSessionWithMountRetries } = await load();

      const pending = checkSessionWithMountRetries('http://test/api/v1');
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(pending).resolves.toEqual({ status: 'throttled' });
    });

    it('does not retry at all on a genuine sign-out', async () => {
      globalThis.fetch = vi.fn(async () => res(401, {})) as never;
      const { checkSessionWithMountRetries } = await load();

      await expect(checkSessionWithMountRetries('http://test/api/v1')).resolves.toEqual({
        status: 'signed-out',
      });
    });
  }
);
