// @vitest-environment jsdom
/**
 * AuthProvider's session check (#2158, #2098): the mount check runs the
 * bounded ladder with `isLoading` held true, and a transient answer (throttle,
 * 5xx, network) never turns a signed-in customer into a guest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getProfileWithMountRetries: vi.fn(),
}));

vi.mock('../lib/api', async importOriginal => {
  const real = await importOriginal<typeof import('../lib/api')>();
  return {
    ...real,
    api: { ...real.api, getProfile: mocks.getProfile },
    getProfileWithMountRetries: mocks.getProfileWithMountRetries,
  };
});

vi.mock('./StoreContext', () => ({ useStore: () => ({ store: { id: 'store-1' } }) }));

let pathname: string | null = '/ar';
// The shared jsdom setup has no localStorage: a Map-backed one, so the session hint is real state.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
// Same for sessionStorage: the once-per-tab probe flag (`authProbe`, lib/api.ts) is real state too.
const tab = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => tab.get(k) ?? null,
  setItem: (k: string, v: string) => void tab.set(k, v),
  removeItem: (k: string) => void tab.delete(k),
  clear: () => tab.clear(),
});
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { AuthProvider, useAuth } from './AuthContext';

const CUSTOMER = { success: true, data: { user: { id: 'u1', role: 'customer' } } };

let latest: ReturnType<typeof useAuth> | null = null;
function Probe() {
  latest = useAuth();
  return null;
}

beforeEach(() => {
  latest = null;
  pathname = '/ar';
  // A returning customer's browser: the session hint is present, so the mount check runs everywhere.
  localStorage.setItem('hadSession', '1');
  mocks.getProfile.mockReset();
  mocks.getProfileWithMountRetries.mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

describe('AuthProvider mount check', () => {
  it('runs the mount ladder and keeps isLoading true until it settles', async () => {
    let settle!: (v: unknown) => void;
    mocks.getProfileWithMountRetries.mockReturnValue(new Promise(r => (settle = r)));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    expect(mocks.getProfileWithMountRetries).toHaveBeenCalledTimes(1);
    expect(mocks.getProfile).not.toHaveBeenCalled();
    expect(latest!.isLoading).toBe(true);

    await act(async () => settle(CUSTOMER));

    expect(latest!.isLoading).toBe(false);
    expect(latest!.user?.id).toBe('u1');
  });

  it.each(['RATE_LIMITED', 'INTERNAL_ERROR', 'NETWORK_ERROR', 'TIMEOUT'])(
    'a later %s on refreshUser leaves the signed-in customer signed in',
    async code => {
      mocks.getProfileWithMountRetries.mockResolvedValue(CUSTOMER);
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>
      );
      await act(async () => {});
      expect(latest!.user?.id).toBe('u1');

      mocks.getProfile.mockResolvedValue({ success: false, error: { code, message: 'x' } });
      await act(async () => {
        await latest!.refreshUser();
      });

      expect(latest!.user?.id).toBe('u1');
    }
  );

  it('a definitive signed-out answer still clears the user', async () => {
    mocks.getProfileWithMountRetries.mockResolvedValue(CUSTOMER);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await act(async () => {});

    mocks.getProfile.mockResolvedValue({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'x' },
    });
    await act(async () => {
      await latest!.refreshUser();
    });

    expect(latest!.user).toBeNull();
  });
});

describe('AuthProvider asks only when it can matter (audit 2026-11-03 #15)', () => {
  const mount = () =>
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

  it('a guest browser (no session hint) on the home page makes NO /auth/me call and is not loading', async () => {
    localStorage.clear();
    pathname = '/ar';
    mount();
    await act(async () => {});
    expect(mocks.getProfileWithMountRetries).not.toHaveBeenCalled();
    expect(latest!.isLoading).toBe(false);
    expect(latest!.user).toBeNull();
  });

  it.each(['/ar/products', '/ar/products/cart-cover', '/en/blog', '/s/shop/ar/blog/my-post'])(
    'a guest on %s stays silent',
    async p => {
      localStorage.clear();
      pathname = p;
      mount();
      await act(async () => {});
      expect(mocks.getProfileWithMountRetries).not.toHaveBeenCalled();
    }
  );

  it('the first time a guest reaches an account/order route it checks once (Safari-ITP cohort)', async () => {
    localStorage.clear();
    mocks.getProfileWithMountRetries.mockResolvedValue({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'x' },
    });
    pathname = '/ar';
    const view = mount();
    await act(async () => {});
    expect(mocks.getProfileWithMountRetries).not.toHaveBeenCalled();

    pathname = '/ar/cart';
    view.rerender(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await act(async () => {});
    expect(mocks.getProfileWithMountRetries).toHaveBeenCalledTimes(1);

    pathname = '/ar/checkout';
    view.rerender(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await act(async () => {});
    expect(mocks.getProfileWithMountRetries).toHaveBeenCalledTimes(1);
  });

  // Pre-QA sweep 2026-11-10 #7: once this tab has asked and been told "no session" (the probe is
  // spent), a guest's later cart / checkout / returns views repeat nothing: no 401 in the console.
  it.each(['/ar/cart', '/en/checkout', '/ar/returns', '/s/shop/ar/track'])(
    'a guest whose tab already spent its probe makes NO call on %s and is not loading',
    async p => {
      localStorage.clear();
      sessionStorage.setItem('authProbe', '1');
      pathname = p;
      mount();
      await act(async () => {});
      expect(mocks.getProfileWithMountRetries).not.toHaveBeenCalled();
      expect(latest!.isLoading).toBe(false);
      expect(latest!.user).toBeNull();
    }
  );

  it('a spent probe never silences a browser that holds a session hint', async () => {
    sessionStorage.setItem('authProbe', '1');
    mocks.getProfileWithMountRetries.mockResolvedValue(CUSTOMER);
    pathname = '/ar/cart';
    mount();
    await act(async () => {});
    expect(mocks.getProfileWithMountRetries).toHaveBeenCalledTimes(1);
    expect(latest!.user?.id).toBe('u1');
  });

  it('a browser WITH a hint checks on a content page too, as before', async () => {
    mocks.getProfileWithMountRetries.mockResolvedValue(CUSTOMER);
    pathname = '/ar/products';
    mount();
    await act(async () => {});
    expect(mocks.getProfileWithMountRetries).toHaveBeenCalledTimes(1);
    expect(latest!.user?.id).toBe('u1');
  });
});
