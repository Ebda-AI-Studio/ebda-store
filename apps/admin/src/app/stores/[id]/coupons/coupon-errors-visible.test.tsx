// @vitest-environment jsdom
/**
 * UX:S-1 / S-2. A failed coupon list read shows an error with a retry (never "no coupons"), and a coupon whose value
 * is 0 (or a percentage over 100) is refused at the field before any request is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: () => {} }),
  usePathname: () => '/stores/store-1/coupons',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock('../../../../lib/api', () => api);
vi.mock('../../../../hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, isLoading: false, gate: null }),
}));
vi.mock('@/components/mobile/BottomSheet', () => ({
  BottomSheet: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock('../_components/ScopePicker', () => ({ ScopePicker: () => null }));

import { ToastProvider } from '@ebda/ui';
import CouponsPage from './page';

const renderPage = () =>
  render(
    <ToastProvider>
      <CouponsPage />
    </ToastProvider>
  );

beforeEach(() => {
  api.apiGet.mockResolvedValue({ data: { coupons: [], groups: [] } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('coupons page errors and value validation', () => {
  it('a failed list read shows the error with a retry, not the empty state', async () => {
    api.apiGet.mockResolvedValue({ error: { message: 'x', status: 500 } });
    renderPage();
    expect(await screen.findByText('loadFailed')).toBeTruthy();
    expect(screen.queryByText('createFirst')).toBeNull();
  });

  it('a 0 value is blocked at the field and nothing is posted', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('create'));
    const code = document.querySelector('input.font-mono') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'ZERO' } });
    const inputs = document.querySelectorAll('input[type="text"]');
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: 'Zero' } });
    fireEvent.change(document.querySelector('input[inputmode="decimal"]') as HTMLInputElement, {
      target: { value: '0' },
    });
    fireEvent.submit(document.getElementById('coupon-form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByText('valueInvalid')).toBeTruthy());
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it('a percentage over 100 is blocked', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('create'));
    fireEvent.change(document.querySelector('input[inputmode="decimal"]') as HTMLInputElement, {
      target: { value: '150' },
    });
    fireEvent.submit(document.getElementById('coupon-form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByText('valuePercentMax')).toBeTruthy());
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});
