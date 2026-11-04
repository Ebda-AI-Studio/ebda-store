// @vitest-environment jsdom
/**
 * Audit 2026-09-30 §9 — enabling `merchant_mcp` (or any feature) did not show
 * up until a hard reload: AdminFeatureProvider fetched the flags once per
 * mount and it stays mounted across every soft navigation. It now exposes
 * `refresh()` and revalidates on window focus / tab visibility.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
const auth = vi.hoisted(() => ({
  user: { id: 'u1', role: 'store_admin' } as { id: string; role: string } | null,
}));

vi.mock('../../lib/api', () => api);
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: auth.user }) }));

import { AdminFeatureProvider, useFeatures } from '../useFeatures';

let refreshFromTest: (() => Promise<void>) | null = null;

function Probe() {
  const { isEnabled, isLoading, loadFailed, refresh } = useFeatures();
  refreshFromTest = refresh;
  return (
    <p data-testid="mcp">
      {isLoading ? 'loading' : loadFailed ? 'failed' : isEnabled('merchant_mcp') ? 'on' : 'off'}
    </p>
  );
}

function renderProvider() {
  return render(
    <AdminFeatureProvider storeId="store-1">
      <Probe />
    </AdminFeatureProvider>
  );
}

function flags(mcp: boolean) {
  return { data: { features: { merchant_mcp: mcp } } };
}

beforeEach(() => {
  auth.user = { id: 'u1', role: 'store_admin' };
  refreshFromTest = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminFeatureProvider revalidation', () => {
  it('a failed FIRST fetch is loadFailed (and isEnabled stays true), not an empty "everything off"', async () => {
    api.apiGet.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('failed'));

    api.apiGet.mockResolvedValueOnce(flags(false));
    await act(async () => {
      await refreshFromTest!();
    });
    expect(screen.getByTestId('mcp').textContent).toBe('off'); // now the server CONFIRMED it is off
  });

  it('a failed REFRESH after a good load keeps the last known flags', async () => {
    api.apiGet.mockResolvedValueOnce(flags(true));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('on'));
    api.apiGet.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    await act(async () => {
      await refreshFromTest!();
    });
    expect(screen.getByTestId('mcp').textContent).toBe('on');
  });

  it('refresh() re-fetches and publishes the new flags without a remount', async () => {
    api.apiGet.mockResolvedValueOnce(flags(false));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('off'));
    expect(api.apiGet).toHaveBeenCalledWith('/api/v1/stores/store-1/my-features');

    api.apiGet.mockResolvedValueOnce(flags(true));
    await act(async () => {
      await refreshFromTest!();
    });
    expect(screen.getByTestId('mcp').textContent).toBe('on');
    expect(api.apiGet).toHaveBeenCalledTimes(2);
  });

  it('refetches when the window regains focus', async () => {
    api.apiGet.mockResolvedValueOnce(flags(false));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('off'));

    api.apiGet.mockResolvedValueOnce(flags(true));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('on'));
  });

  it('refetches when the tab becomes visible again', async () => {
    api.apiGet.mockResolvedValueOnce(flags(false));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('off'));

    api.apiGet.mockResolvedValueOnce(flags(true));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('on'));
  });

  it('a failed refresh keeps the last known flags (never blanks them)', async () => {
    api.apiGet.mockResolvedValueOnce(flags(true));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('mcp').textContent).toBe('on'));

    api.apiGet.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await act(async () => {
      await refreshFromTest!();
    });
    expect(screen.getByTestId('mcp').textContent).toBe('on');
  });

  it('a slow older response never overwrites a newer one', async () => {
    let resolveSlow: (v: unknown) => void = () => {};
    api.apiGet.mockImplementationOnce(() => new Promise(r => (resolveSlow = r)));
    renderProvider();

    api.apiGet.mockResolvedValueOnce(flags(true));
    await act(async () => {
      await refreshFromTest!();
    });
    expect(screen.getByTestId('mcp').textContent).toBe('on');

    await act(async () => {
      resolveSlow(flags(false));
    });
    expect(screen.getByTestId('mcp').textContent).toBe('on');
  });
});
