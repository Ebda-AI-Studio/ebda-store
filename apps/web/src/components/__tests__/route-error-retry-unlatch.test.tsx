// @vitest-environment jsdom
/**
 * #2130 — the transient platform-host page renders ONE control (Try Again): no
 * chrome, no Go Home (SR-7). `useTransition`'s pending flag only clears when
 * `router.refresh()` settles, and the refresh waits on the API that just
 * failed, so a hung refresh latched that only control disabled forever.
 *
 * jsdom cannot hang a real RSC refresh, so `useTransition` is pinned to
 * "pending forever" here — exactly the production failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

// Once started, the transition never settles; the callback still runs.
const transition = { pending: false };
vi.mock('react', async importOriginal => {
  const real = await importOriginal<typeof import('react')>();
  return {
    ...real,
    useTransition: () =>
      [
        transition.pending,
        (fn: () => void) => {
          transition.pending = true;
          fn();
        },
      ] as const,
  };
});
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', t: (en: string) => en }),
  translations: { 'Retrying…': 'Retrying…' },
}));
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 'demo', slug: 'demo' } }),
  useStoreUrl: () => (p: string) => p,
  useIsPlatform: () => true,
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));

import { RouteErrorFallback, RETRY_MAX_BUSY_MS } from '../RouteErrorFallback';
import { STORE_UNAVAILABLE_DIGEST } from '../../lib/store-unavailable';

const transient = Object.assign(new Error('busy'), { digest: STORE_UNAVAILABLE_DIGEST });

describe('RouteErrorFallback — a hung refresh cannot latch the only control (#2130)', () => {
  const reload = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    reload.mockReset();
    refresh.mockReset();
    transition.pending = false;
  });

  it('re-enables after RETRY_MAX_BUSY_MS, and the next click hard-reloads', () => {
    const { getByRole, queryByText } = render(
      <RouteErrorFallback error={transient} reset={() => {}} />
    );
    // Platform-host transient: Try Again is the only control on the page.
    expect(queryByText('Go Home')).toBeNull();
    const button = getByRole('button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RETRY_MAX_BUSY_MS + 10);
    });
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    // The soft refresh is still pending — a second one would queue behind it.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
