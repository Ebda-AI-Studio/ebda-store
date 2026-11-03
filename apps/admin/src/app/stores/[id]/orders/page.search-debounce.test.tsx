// @vitest-environment jsdom
/**
 * Admin Orders search is debounced (the QA sweep of 2026-11-02 saw one request per keystroke): typing quickly sends ONE
 * list request carrying the final text, not one per character.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/stores/store-1/orders',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/DateRangePicker', () => ({ DateRangePicker: () => null }));
vi.mock('../../../../lib/api', () => api);
vi.mock('../../../../lib/auth', () => ({ useAuth: () => ({ user: { role: 'store_admin' } }) }));

import { ToastProvider } from '@ebda/ui';
import OrdersPage from './page';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  api.apiGet.mockResolvedValue({ data: { orders: [], meta: { total: 0, totalPages: 1 } } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('orders list search', () => {
  it('sends one request for a burst of keystrokes, with the final text', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <OrdersPage />
      </ToastProvider>
    );
    await waitFor(() => expect(api.apiGet).toHaveBeenCalled());
    const box = await screen.findByRole('searchbox').catch(() => screen.getByRole('textbox'));
    await vi.advanceTimersByTimeAsync(400);
    api.apiGet.mockClear();
    for (const v of ['a', 'al', 'ali']) fireEvent.change(box, { target: { value: v } });
    await vi.advanceTimersByTimeAsync(100);
    expect(api.apiGet).not.toHaveBeenCalled(); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledTimes(1));
  });
});
