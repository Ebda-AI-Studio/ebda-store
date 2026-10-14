// @vitest-environment jsdom
/**
 * Regression for #174: FocusModeContext restores `ebda_focus_mode` from
 * localStorage on mount with NO per-user validation, and logout() only ever
 * cleared accessToken/refreshToken/csrfToken. A second admin signing into
 * the same device inherited whichever store the PREVIOUS admin last
 * focused.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { AuthProvider, useAuth } from '../auth';
import { FOCUS_MODE_STORAGE_KEY } from '@/contexts/FocusModeContext';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  // '/login' so the mount effect skips its own checkAuth()/fetch — this
  // test is only about what logout() clears, not the mount-time auth check.
  usePathname: () => '/login',
}));

vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { has: () => true }),
}));

vi.mock('@ebda/shared', () => ({
  isIosWebkit: () => false,
  safeInternalPath: (raw: string | null, fallback: string) => raw ?? fallback,
}));

// jsdom's window.localStorage needs a real http(s) origin to enable —
// sidestep with a minimal in-memory mock (globalThis IS window in jsdom).
function makeLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuthProvider logout (#174)', () => {
  it('clears the focus-mode key along with the auth tokens', async () => {
    vi.stubGlobal('localStorage', makeLocalStorageMock());
    localStorage.setItem('accessToken', 'a');
    localStorage.setItem('refreshToken', 'r');
    localStorage.setItem('csrfToken', 'c');
    localStorage.setItem(FOCUS_MODE_STORAGE_KEY, JSON.stringify({ storeId: 'store-1' }));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider>,
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(localStorage.getItem(FOCUS_MODE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('accessToken')).toBeNull();
    expect(localStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.getItem('csrfToken')).toBeNull();
  });
});
