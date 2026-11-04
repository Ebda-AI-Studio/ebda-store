// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `refreshAccessToken()` is the single function every refresh path funnels through (the mount check, the 401 retry in
 * `apiRequest`, the context callback). The session now lives at the identity service (Rulings ID-1/ID-2): it asks
 * accounts.ebda.app for a fresh Store token with that service's HttpOnly cookie, then exchanges the token for the Store
 * API's own cookie. Nothing credential-like is read from or written to JS storage.
 */
describe('refreshAccessToken (identity service)', () => {
  function storageMock() {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }
  const json = (status: number, body: unknown) => ({
    status,
    ok: status < 400,
    json: async () => body,
  });

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', storageMock());
    vi.stubGlobal('sessionStorage', storageMock());
  });

  it('exchanges the identity-service token for the Store cookie, and keeps nothing in JS storage', async () => {
    localStorage.setItem('hadSession', '1');
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { success: true, data: { access_token: 'tok', expires_at: 1 } })
      )
      .mockResolvedValueOnce(json(200, { success: true, data: { user: { id: 'u1' } } }));
    vi.stubGlobal('fetch', fetchSpy);
    const { refreshAccessToken } = await import('../api');

    expect(await refreshAccessToken()).toBe('tok');

    const [first, second] = fetchSpy.mock.calls;
    expect(first[0]).toContain('/token?aud=store');
    expect(first[1]).toMatchObject({ credentials: 'include' });
    expect(second[0]).toContain('/api/v1/auth/session');
    expect(second[1].headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
  });

  it('a signed-out identity session (401) is "rejected", not an error', async () => {
    localStorage.setItem('hadSession', '1');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(401, { success: false, error: { code: 'NO_SESSION', message: 'x' } })
        )
    );
    const { refreshAccessToken } = await import('../api');
    expect(await refreshAccessToken()).toBeNull();
  });

  it('a throttle or an outage is not "signed out": it reaches the caller as a throttle', async () => {
    localStorage.setItem('hadSession', '1');
    for (const status of [429, 503]) {
      vi.resetModules();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(json(status, { success: false, error: { code: 'X', message: 'x' } }))
      );
      const { refreshSession } = await import('../api');
      expect(await refreshSession()).toBe('throttled');
    }
  });

  it('offline (fetch rejects) and a 500 are transient: throttled, never rejected, never "session ended"', async () => {
    localStorage.setItem('hadSession', '1');
    const ended = vi.fn();
    vi.doMock('../session-ended', () => ({ handleSessionEnded: ended }));
    for (const failure of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(json(500, { success: false, error: { code: 'SERVER_ERROR' } })),
    ]) {
      vi.resetModules();
      vi.doMock('../session-ended', () => ({ handleSessionEnded: ended }));
      vi.stubGlobal('fetch', vi.fn(failure));
      const { refreshSession, getFreshAccessToken } = await import('../api');
      expect(await refreshSession()).toBe('throttled');
      // the realtime socket's token source throws (transient) instead of answering null (= revoked)
      await expect(getFreshAccessToken()).rejects.toThrow();
    }
    expect(ended).not.toHaveBeenCalled();
  });

  it('"session ended" only when a signed-in session is revoked mid-use, not on a first-load check', async () => {
    localStorage.setItem('hadSession', '1');
    const ended = vi.fn();
    vi.doMock('../session-ended', () => ({ handleSessionEnded: ended }));
    const noSession = () =>
      json(401, { success: false, error: { code: 'NO_SESSION', message: 'x' } });

    // first load: nobody was signed in on this page yet
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noSession()));
    const api = await import('../api');
    expect(await api.refreshAccessToken()).toBeNull();
    expect(ended).not.toHaveBeenCalled();

    // signed in, then revoked mid-use
    api.rememberGrant({ access_token: 'tok', expires_at: Date.now() + 600_000 });
    expect(await api.refreshAccessToken()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);

    // after a deliberate sign-out the stored session is cleared: stragglers stay quiet
    api.clearStoredSession();
    expect(await api.refreshAccessToken()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
  });
});
