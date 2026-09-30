/**
 * The admin + orders session check is only allowed to change what it was
 * asked about.
 *
 * Four findings on the orders PWA (mirrored on admin, Ruling P2-B2-5):
 *  - #2096 a non-401 answer on /auth/me (a 502 during a deploy, a 429) was
 *    read as "signed out" and bounced a staff user to /login mid-shift;
 *  - #2161 a check that started before a login could land after it and
 *    clear the tokens the login had just written;
 *  - #2165 every navigation started another ~21s ladder with nothing
 *    stopping the older ones, and any of them could re-populate `user`
 *    after a logout;
 *  - #2160 a logout whose POST never reached the API was undone by the very
 *    next session check, because the cookies it failed to clear still
 *    answered /auth/me with 200.
 *
 * AuthProvider cannot be rendered here (no jsdom — Ruling P2-B2-2), so the
 * decisions live in plain api.ts functions and are driven directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

// A localStorage stand-in; see refresh-throttle-not-logout.test.ts for why
// this file does not switch its test environment.
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

function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

const API = 'http://test/api/v1';
// What AuthService.getProfile's AppError(404) serialises to.
const GONE = { success: false, error: { code: 'NOT_FOUND', message: 'User not found' } };
const urlOf = (u: unknown) => String(u);

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('accessToken', 'old-access');
  localStorage.setItem('refreshToken', 'old-refresh');
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ['admin', () => import('@admin/lib/api')],
  ['orders', () => import('@orders/lib/api')],
])('%s client — session-check races', (_name, load) => {
  describe('#2096 — only 401-then-rejected ends a session', () => {
    it.each([500, 502, 503, 404])(
      'a %i on /auth/me with no API error body is "unavailable", not "signed-out", and posts no refresh',
      async status => {
        globalThis.fetch = vi.fn(async () => res(status)) as never;
        const { checkSession } = await load();

        await expect(checkSession(API)).resolves.toEqual({ status: 'unavailable' });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('refreshToken')).toBe('old-refresh');
      }
    );

    // #2283: 404 is AuthService.getProfile saying the user row is gone — an
    // answer about the identity, not an outage. The shell must not survive it.
    it('a 404 on /auth/me (account deleted) is "signed-out" and clears the session', async () => {
      globalThis.fetch = vi.fn(async () => res(404, GONE)) as never;
      const { checkSession } = await load();

      await expect(checkSession(API)).resolves.toEqual({ status: 'signed-out' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1); // nothing left to refresh
      expect(localStorage.getItem('refreshToken')).toBeNull();
      expect(localStorage.getItem('accessToken')).toBeNull();
    });

    it('a 404 on the post-refresh /auth/me retry is "signed-out" too', async () => {
      let meCalls = 0;
      globalThis.fetch = vi.fn(async (url: unknown) => {
        if (urlOf(url).includes('/auth/refresh')) {
          return res(200, { success: true, data: { refreshed: true } });
        }
        meCalls += 1;
        return meCalls === 1 ? res(401) : res(404, GONE);
      }) as never;
      const { checkSession } = await load();

      await expect(checkSession(API)).resolves.toEqual({ status: 'signed-out' });
      expect(meCalls).toBe(2);
      expect(localStorage.getItem('refreshToken')).toBeNull();
    });

    it('a 429 on /auth/me is "throttled", so the mount ladder retries it', async () => {
      globalThis.fetch = vi.fn(async () => res(429)) as never;
      const { checkSession } = await load();

      await expect(checkSession(API)).resolves.toEqual({ status: 'throttled' });
      expect(localStorage.getItem('refreshToken')).toBe('old-refresh');
    });

    it('negative control: a 401 whose refresh is rejected still signs out', async () => {
      globalThis.fetch = vi.fn(async () => res(401)) as never;
      const { checkSession } = await load();

      await expect(checkSession(API)).resolves.toEqual({ status: 'signed-out' });
      expect(localStorage.getItem('refreshToken')).toBeNull();
    });
  });

  describe('#2161 — a login during an in-flight check survives it', () => {
    it('does not clear tokens a login wrote while the refresh was in flight', async () => {
      let releaseRefresh!: (r: Response) => void;
      globalThis.fetch = vi.fn((url: unknown) => {
        if (urlOf(url).includes('/auth/refresh')) {
          return new Promise<Response>(r => (releaseRefresh = r));
        }
        return Promise.resolve(res(401));
      }) as never;
      const { checkSession, bumpSessionGeneration } = await load();

      const pending = checkSession(API);
      await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));

      // The login lands: storeSession bumps the generation and writes a pair.
      bumpSessionGeneration();
      localStorage.setItem('accessToken', 'fresh-access');
      localStorage.setItem('refreshToken', 'fresh-refresh');

      // The anonymous refresh the check started now comes back rejected.
      releaseRefresh(res(400));

      await expect(pending).resolves.toEqual({ status: 'superseded' });
      expect(localStorage.getItem('accessToken')).toBe('fresh-access');
      expect(localStorage.getItem('refreshToken')).toBe('fresh-refresh');
    });
  });

  describe('#2165 — a superseded ladder stops and applies nothing', () => {
    beforeEach(() => vi.useFakeTimers());

    it('stops at its next sleep once a newer check has started', async () => {
      globalThis.fetch = vi.fn(async (url: unknown) =>
        urlOf(url).includes('/auth/refresh') ? res(429) : res(401)
      ) as never;
      const { checkSessionWithMountRetries } = await load();

      let current = true;
      const pending = checkSessionWithMountRetries(API, { isCurrent: () => current });
      await vi.advanceTimersByTimeAsync(2_000); // first attempt (incl. inner 1.5s retry) done
      const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      current = false; // a navigation started a newer check
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toEqual({ status: 'superseded' });
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });

    it('cannot report "authenticated" for a session a logout ended mid-check', async () => {
      let releaseMe!: (r: Response) => void;
      globalThis.fetch = vi.fn((url: unknown) => {
        if (urlOf(url).includes('/auth/me')) return new Promise<Response>(r => (releaseMe = r));
        return Promise.resolve(res(200, { success: true }));
      }) as never;
      const { checkSessionWithMountRetries, performLogout } = await load();

      const pending = checkSessionWithMountRetries(API);
      await vi.waitFor(() => expect(releaseMe).toBeTypeOf('function'));
      await performLogout(API, null);
      releaseMe(res(200, { data: { user: { id: 'u1' } } }));

      await expect(pending).resolves.toEqual({ status: 'superseded' });
    });
  });

  describe('#2160 — a logout the server never received is not undone', () => {
    it('keeps the logout pending and never reads /auth/me while it is', async () => {
      const calls: string[] = [];
      let logoutReachable = false;
      globalThis.fetch = vi.fn(async (url: unknown) => {
        calls.push(urlOf(url));
        if (urlOf(url).includes('/auth/logout')) {
          if (!logoutReachable) throw new TypeError('Failed to fetch');
          return res(200, { success: true });
        }
        // The cookies the failed logout could not clear are still live.
        return res(200, { data: { user: { id: 'staff-1' } } });
      }) as never;
      const { performLogout, checkSession, isLogoutPending } = await load();

      await expect(performLogout(API, null)).resolves.toBe(false);
      expect(isLogoutPending()).toBe(true);

      // The /login re-check that used to sign the staff member back in.
      await expect(checkSession(API)).resolves.toEqual({ status: 'signed-out' });
      expect(calls.some(c => c.includes('/auth/me'))).toBe(false);
      expect(isLogoutPending()).toBe(true);

      // Connectivity returns: the next check delivers the logout and lifts it.
      logoutReachable = true;
      await expect(checkSession(API)).resolves.toEqual({ status: 'signed-out' });
      expect(isLogoutPending()).toBe(false);
    });

    it('re-sends the iOS refresh token the failed logout had to revoke', async () => {
      const bodies: unknown[] = [];
      let fail = true;
      globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
        if (urlOf(url).includes('/auth/logout')) {
          bodies.push(JSON.parse(String(init?.body)));
          if (fail) throw new TypeError('offline');
          return res(200);
        }
        return res(401);
      }) as never;
      const { performLogout, checkSession } = await load();

      await performLogout(API, 'ios-refresh');
      fail = false;
      await checkSession(API);

      expect(bodies).toEqual([{ refreshToken: 'ios-refresh' }, { refreshToken: 'ios-refresh' }]);
    });

    it('a confirmed logout leaves nothing pending, and a login lifts a pending one', async () => {
      globalThis.fetch = vi.fn(async () => res(200)) as never;
      const { performLogout, isLogoutPending, clearPendingLogout } = await load();

      await expect(performLogout(API, null)).resolves.toBe(true);
      expect(isLogoutPending()).toBe(false);

      globalThis.fetch = vi.fn(async () => res(503)) as never;
      await performLogout(API, null);
      expect(isLogoutPending()).toBe(true);
      clearPendingLogout(); // what storeSession() does on an explicit login
      expect(isLogoutPending()).toBe(false);
    });
  });
});

/**
 * The provider half cannot be rendered here, so its wiring is pinned at the
 * source: without these call sites the api.ts guards above are never reached.
 */
describe('AuthProvider wiring (admin + orders)', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const src = (app: string) =>
    readFileSync(resolve(__dirname, `../../apps/${app}/src/lib/auth.tsx`), 'utf8');

  it.each(['admin', 'orders'])(
    '%s: a login bumps the generation and lifts a pending logout',
    app => {
      const s = src(app);
      const storeSession = s.slice(
        s.indexOf('function storeSession('),
        s.indexOf('async function login(')
      );
      expect(storeSession).toContain('bumpSessionGeneration();');
      expect(storeSession).toContain('clearPendingLogout();');
    }
  );

  it.each(['admin', 'orders'])(
    '%s: logout goes through performLogout, not a swallowed fetch',
    app => {
      const s = src(app);
      const logout = s.slice(s.indexOf('async function logout()'));
      expect(logout).toContain('await performLogout(API_URL, refreshTokenValue);');
      expect(logout).not.toContain('/auth/logout`');
    }
  );

  it('orders: a navigation supersedes the previous check and only the newest clears isLoading', () => {
    const s = src('orders');
    expect(s).toContain('checkSessionWithMountRetries(API_URL, { isCurrent })');
    expect(s).toContain('if (isCurrent()) setIsLoading(false);');
  });
});
