// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression for #1803: `refreshAccessToken()` is the single function every
 * refresh path funnels through — `checkAuth`'s direct `refreshSession()`
 * call in auth.tsx, the transparent 401-retry in `apiRequest`, AND the
 * `refreshToken()` context callback. The iOS-with-no-stored-token bail-out
 * ("there is nothing to exchange, don't bother the server") previously lived
 * ONLY inside the `refreshToken()` callback, which `checkAuth` never calls —
 * it calls `refreshSession()` -> `refreshAccessToken()` directly. A
 * logged-out iOS PWA therefore hit POST /auth/refresh on every mount only to
 * be rejected, instead of skipping the doomed round-trip like every other
 * path already did (apps/web's client has carried this same guard inside
 * refreshAccessToken() itself all along).
 */
describe('refreshAccessToken iOS bail-out (#1803)', () => {
  const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

  // jsdom's window.localStorage needs a real http(s) origin to enable —
  // sidestep that entirely with a minimal in-memory mock (globalThis IS
  // window in jsdom, so this is visible to the bare `localStorage.*` calls
  // in the source under test).
  function makeLocalStorageMock() {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', makeLocalStorageMock());
    Object.defineProperty(navigator, 'userAgent', { value: iphoneUA, configurable: true });
  });

  it('skips the network call on iOS when no refresh token is stored', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { refreshAccessToken } = await import('../api');

    const result = await refreshAccessToken();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still calls /auth/refresh on iOS when a refresh token IS stored', async () => {
    localStorage.setItem('refreshToken', 'a-real-refresh-token');
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ success: true, data: { accessToken: 'new-token' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { refreshAccessToken } = await import('../api');

    const result = await refreshAccessToken();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe('new-token');
  });
  // Issue 2170: when the server answers the cookie FALLBACK (our stored body
  // token was dead, the cookie session was rotated instead), the stored pair
  // must go — the refresh token would trip reuse detection and revoke every
  // session, and the stored Bearer outranks the fresh cookie.
  it('drops the stored pair when the server says the stored refresh token is stale', async () => {
    localStorage.setItem('refreshToken', 'dead-refresh');
    localStorage.setItem('accessToken', 'dead-access');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          success: true,
          data: { refreshed: true, csrfToken: 'c', staleRefreshToken: true },
        }),
      })
    );
    const { refreshAccessToken } = await import('../api');

    const result = await refreshAccessToken();

    expect(result).not.toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
  });
});
