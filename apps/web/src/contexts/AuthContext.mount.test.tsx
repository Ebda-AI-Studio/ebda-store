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

import { AuthProvider, useAuth } from './AuthContext';

const CUSTOMER = { success: true, data: { user: { id: 'u1', role: 'customer' } } };

let latest: ReturnType<typeof useAuth> | null = null;
function Probe() {
  latest = useAuth();
  return null;
}

beforeEach(() => {
  latest = null;
  mocks.getProfile.mockReset();
  mocks.getProfileWithMountRetries.mockReset();
});
afterEach(() => cleanup());

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
