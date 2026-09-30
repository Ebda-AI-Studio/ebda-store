// @vitest-environment jsdom
/**
 * Audit 2026-09-30 §8 — opening Discount Coupons showed a bare spinner with
 * no sidebar/hub tabs/topbar, then the admin reappeared: the page returned
 * its loading spinner BEFORE <AdminLayout>, so the chrome unmounted for the
 * whole fetch. The loading state must render INSIDE the layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));
const gate = vi.hoisted(() => ({ value: null as ReactNode }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: () => {} }),
  usePathname: () => '/stores/store-1/coupons',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => (
    <div data-testid="admin-layout">{children}</div>
  ),
}));
vi.mock('../../../../lib/api', () => api);
vi.mock('../../../../hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, isLoading: false, gate: gate.value }),
}));

import { ToastProvider } from '@force/ui';
import CouponsPage from './page';

beforeEach(() => {
  gate.value = null;
  // Never resolves: the page stays in its loading state for the assertion.
  api.apiGet.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Coupons page loading state', () => {
  it('keeps the admin layout mounted while coupons load', () => {
    const { container } = render(
      <ToastProvider>
        <CouponsPage />
      </ToastProvider>
    );
    const layout = screen.getByTestId('admin-layout');
    // The skeleton is INSIDE the layout, and no bare spinner is left outside it.
    expect(layout.querySelector('.force-skeleton')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('shows the upgrade gate (not a spinner) for a store without the feature', () => {
    gate.value = <p data-testid="gate">upgrade</p>;
    render(
      <ToastProvider>
        <CouponsPage />
      </ToastProvider>
    );
    expect(screen.getByTestId('gate')).toBeTruthy();
  });
});
