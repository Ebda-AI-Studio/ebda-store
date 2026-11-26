/**
 * Storefront ApiClient refresh gates — backlog batch e-web-orders.
 *
 * - #2148: POST /auth/refresh's 400 ("no refresh token presented") clears dead
 *   session cookies, so it is the same fact as a 401 and a CSRF-403 is retried
 *   once after it — on the SAME write, not the next one.
 * - #2097: every /auth/ route behind `authenticate` (change-password) heals on
 *   a 401 like any other route; only the credential-less entry points skip.
 * - #2164 vs #2157: ONE evidence-free /auth/me refresh per tab (sessionStorage),
 *   so the Safari-ITP cohort (localStorage evicted, refresh cookie alive) is
 *   recovered while anonymous browsing costs at most one refresh per tab.
 * - #2158 / #2098: getProfileWithMountRetries — the storefront's bounded mount
 *   ladder, matching admin/orders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

function makeStorage() {
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

const local = makeStorage();
const session = makeStorage();

function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    clone() {
      return this;
    },
  } as unknown as Response;
}

const CSRF_403 = { success: false, error: { code: 'CSRF_INVALID', message: 'bad csrf' } };
const NO_TOKEN_400 = {
  success: false,
  error: { code: 'VALIDATION_ERROR', message: 'Refresh token is required' },
};
const ME_OK = { success: true, data: { user: { id: 'u1', role: 'customer' } } };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('window', {
    localStorage: local,
    sessionStorage: session,
    navigator: { userAgent: 'node' },
  });
  vi.stubGlobal('navigator', { userAgent: 'node' });
  local.clear();
  session.clear();
  local.setItem('sessionId', 'sess_test');
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const urls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map(c => String(c[0]));
const refreshes = (m: ReturnType<typeof vi.fn>) => urls(m).filter(u => u.includes('/auth/refresh'));

describe('#2148 — a refresh 400 that cleared dead cookies heals the SAME write', () => {
  it('retries the CSRF-403 once after the 400 and returns the guest-path success', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) return res(400, NO_TOKEN_400);
      attempts += 1;
      return attempts === 1 ? res(403, CSRF_403) : res(200, { success: true, data: { ok: 1 } });
    });
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.post('/cart/items', { productId: 'p1', quantity: 1 });

    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
    expect(refreshes(fetchMock)).toHaveLength(1);
  });

  it('a 400 ends the session locally: stale evidence is dropped, no refresh on the next load', async () => {
    local.setItem('hadSession', '1');
    local.setItem('csrfToken', 'stale');
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh') ? res(400, NO_TOKEN_400) : res(401, { success: false })
    );
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');
    session.setItem('authProbe', '1'); // this tab already spent its probe

    await api.getProfile();
    expect(refreshes(fetchMock)).toHaveLength(1);
    expect(local.getItem('hadSession')).toBeNull();
    expect(local.getItem('csrfToken')).toBeNull();

    await api.getProfile();
    expect(refreshes(fetchMock)).toHaveLength(1);
  });
});

describe('#2097 — authenticated /auth/ routes heal; credential-less ones do not refresh', () => {
  it('change-password: a 401 refreshes and retries once', async () => {
    local.setItem('hadSession', '1');
    let attempts = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) {
        return res(200, { success: true, data: { refreshed: true, csrfToken: 'c2' } });
      }
      attempts += 1;
      return attempts === 1
        ? res(401, { success: false })
        : res(200, { success: true, data: { message: 'ok' } });
    });
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.changePassword('old', 'newPassw0rd!');

    expect(result.success).toBe(true);
    expect(refreshes(fetchMock)).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('change-password: a CSRF-403 re-mints via refresh and retries', async () => {
    local.setItem('hadSession', '1');
    let attempts = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) {
        return res(200, { success: true, data: { refreshed: true, csrfToken: 'fresh' } });
      }
      attempts += 1;
      return attempts === 1
        ? res(403, CSRF_403)
        : res(200, { success: true, data: { message: 'ok' } });
    });
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.changePassword('old', 'newPassw0rd!');

    expect(result.success).toBe(true);
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>)['X-CSRF-Token']).toBe('fresh');
  });

  it.each(['/auth/login', '/auth/forgot-password', '/auth/reset-password', '/auth/refresh'])(
    '%s: a 401 never triggers a refresh',
    async endpoint => {
      local.setItem('hadSession', '1');
      const fetchMock = vi.fn(async () => res(401, { success: false }));
      globalThis.fetch = fetchMock as never;
      const { endpointMayRefresh } = await import('@web/lib/api');
      expect(endpointMayRefresh(endpoint)).toBe(false);
    }
  );

  it('login with wrong credentials does not spend a refresh', async () => {
    local.setItem('hadSession', '1');
    const fetchMock = vi.fn(async () =>
      res(401, { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'no' } })
    );
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    await api.login('a@b.co', 'wrong');

    expect(refreshes(fetchMock)).toHaveLength(0);
  });
});

describe('#2164 / #2157 — one evidence-free session probe per tab', () => {
  it('iOS-ITP cohort: no localStorage evidence, refresh cookie alive → signed in', async () => {
    let meCalls = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) {
        return res(200, { success: true, data: { refreshed: true, csrfToken: 'c' } });
      }
      meCalls += 1;
      return meCalls === 1 ? res(401, { success: false }) : res(200, ME_OK);
    });
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    const result = await api.getProfile();

    expect(result.success).toBe(true);
    expect(refreshes(fetchMock)).toHaveLength(1);
    // The recovered session re-arms the evidence marker for later loads.
    expect(local.getItem('hadSession')).toBe('1');
  });

  it('anonymous visitor: at most ONE refresh per tab, however many page loads', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh') ? res(400, NO_TOKEN_400) : res(401, { success: false })
    );
    globalThis.fetch = fetchMock as never;

    for (let load = 0; load < 5; load += 1) {
      vi.resetModules(); // a fresh page load re-imports the client
      const { api } = await import('@web/lib/api');
      const r = await api.getProfile();
      expect(r.error?.code).not.toBe('RATE_LIMITED');
    }

    expect(refreshes(fetchMock)).toHaveLength(1);
  });

  it('the probe is for the session check only — other 401s never spend it', async () => {
    const fetchMock = vi.fn(async () => res(401, { success: false }));
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    await api.getCart();

    expect(refreshes(fetchMock)).toHaveLength(0);
    expect(session.getItem('authProbe')).toBeNull();
  });

  it('sessionProbeSpent: false until the tab has asked once and been told there is no session', async () => {
    // Two different answers, so the test can tell the two requests apart: the profile read says 401,
    // and the one refresh it spends says "no refresh token" (the API's real no-session answer).
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('/auth/refresh')
        ? res(400, NO_TOKEN_400)
        : res(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'x' } })
    );
    globalThis.fetch = fetchMock as never;
    const { api, sessionProbeSpent, hasSessionHint } = await import('@web/lib/api');

    expect(sessionProbeSpent()).toBe(false);
    const result = await api.getProfile();
    expect(result.success).toBe(false);
    expect(urls(fetchMock).filter(u => u.split('?')[0].endsWith('/auth/me'))).toHaveLength(1);
    expect(refreshes(fetchMock)).toHaveLength(1);
    expect(sessionProbeSpent()).toBe(true);
    expect(hasSessionHint()).toBe(false); // spent probe + no hint = a guest
  });

  it('the probe that finds a session (refresh succeeds) retries the read and leaves the session hint', async () => {
    let meCalls = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) {
        return res(200, { success: true, data: { refreshed: true, csrfToken: 'c2' } });
      }
      meCalls += 1;
      return meCalls === 1 ? res(401, { success: false }) : res(200, ME_OK);
    });
    globalThis.fetch = fetchMock as never;
    const { api, hasSessionHint } = await import('@web/lib/api');

    const result = await api.getProfile();
    expect(result.success).toBe(true);
    expect(meCalls).toBe(2);
    expect(refreshes(fetchMock)).toHaveLength(1);
    // A server that rotated the session is proof one exists: the marker is written, so this customer is
    // never mistaken for a guest by the spent-probe check.
    expect(local.getItem('hadSession')).toBe('1');
    expect(hasSessionHint()).toBe(true);
  });

  it('sessionProbeSpent: no sessionStorage → false, so the caller keeps asking (never a silent guest)', async () => {
    vi.stubGlobal('window', { localStorage: local, navigator: { userAgent: 'node' } });
    const { sessionProbeSpent } = await import('@web/lib/api');
    expect(sessionProbeSpent()).toBe(false);
  });

  it('no sessionStorage available → no evidence-free probe (conservative budget)', async () => {
    vi.stubGlobal('window', { localStorage: local, navigator: { userAgent: 'node' } });
    const fetchMock = vi.fn(async () => res(401, { success: false }));
    globalThis.fetch = fetchMock as never;
    const { api } = await import('@web/lib/api');

    await api.getProfile();

    expect(refreshes(fetchMock)).toHaveLength(0);
  });
});

describe('#2158 / #2098 — getProfileWithMountRetries (storefront mount ladder)', () => {
  it('waits out a throttle instead of settling the customer as a guest', async () => {
    local.setItem('hadSession', '1');
    let meCalls = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/auth/refresh')) return res(429, { success: false });
      meCalls += 1;
      return meCalls <= 2 ? res(401, { success: false }) : res(200, ME_OK);
    });
    globalThis.fetch = fetchMock as never;
    const { getProfileWithMountRetries } = await import('@web/lib/api');
    const sleep = vi.fn(async () => {});

    const result = await getProfileWithMountRetries(sleep);

    expect(result.success).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'a direct 429',
      () => res(429, { success: false, error: { code: 'RATE_LIMITED', message: 'x' } }),
    ],
    [
      'a non-JSON 502 from the edge',
      () => ({
        ...res(502),
        json: async () => {
          throw new SyntaxError('x');
        },
      }),
    ],
    ['a 5xx', () => res(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'x' } })],
  ])('retries %s, bounded by the ladder', async (_label, make) => {
    const fetchMock = vi.fn(async () => make() as Response);
    globalThis.fetch = fetchMock as never;
    const { getProfileWithMountRetries, PROFILE_MOUNT_RETRY_DELAYS_MS, isTransientSessionAnswer } =
      await import('@web/lib/api');
    const sleep = vi.fn(async () => {});

    const result = await getProfileWithMountRetries(sleep);

    expect(isTransientSessionAnswer(result)).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(PROFILE_MOUNT_RETRY_DELAYS_MS.length);
    expect(fetchMock).toHaveBeenCalledTimes(PROFILE_MOUNT_RETRY_DELAYS_MS.length + 1);
  });

  it('a genuine signed-out answer (401, no session) is not retried', async () => {
    session.setItem('authProbe', '1');
    const fetchMock = vi.fn(async () =>
      res(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'x' } })
    );
    globalThis.fetch = fetchMock as never;
    const { getProfileWithMountRetries, isTransientSessionAnswer } = await import('@web/lib/api');
    const sleep = vi.fn(async () => {});

    const result = await getProfileWithMountRetries(sleep);

    expect(isTransientSessionAnswer(result)).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });
});
