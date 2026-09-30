// @vitest-environment jsdom
/**
 * Audit 2026-09-30 §10 — Customers page UI pass: KPI strip from the API's
 * store-wide `meta.summary` (unknown rendered as unknown, never 0), segment
 * pills built from the loaded RFM snapshots that filter server-side, and the
 * shared SearchInput.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiFetch: vi.fn(),
  unwrapList: (d: unknown) => (Array.isArray(d) ? d : []),
}));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: () => {} }),
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
vi.mock('../../../../lib/api', () => api);

import { ToastProvider } from '@force/ui';
import CustomersPage from './page';

const ROWS = [
  {
    id: 'u1',
    firstName: 'Ahmed',
    lastName: 'S',
    email: 'a@x.test',
    phone: '+96599001234',
    totalOrders: 3,
    totalSpent: 30000,
    avgOrderValue: 10000,
    lastOrderDate: '2026-09-01T00:00:00.000Z',
    isGuest: false,
    address: 'Block 1, Salmiya',
    lastOrderPaymentStatus: 'paid',
  },
];
const SUMMARY = {
  customers: 12,
  guests: 2,
  buyers: 8,
  repeatBuyers: 2,
  repeatRate: 0.25,
  orders: 16,
  totalSpent: 216530,
  avgOrderValue: 13533,
};

function listResponse(summary: unknown = SUMMARY) {
  return {
    data: {
      data: ROWS,
      meta: { page: 1, perPage: 20, total: 1, totalPages: 1, truncated: false, summary },
    },
  };
}

function mockApi(list: () => unknown) {
  api.apiGet.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('rfm-batch')
        ? { data: [{ customerId: 'u1', segment: 'vip' }] }
        : (list() as object)
    )
  );
}

function renderPage() {
  return render(
    <ToastProvider>
      <CustomersPage />
    </ToastProvider>
  );
}

beforeEach(() => mockApi(() => listResponse()));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Customers page KPI strip', () => {
  it('renders the store-wide summary from meta.summary', async () => {
    renderPage();
    const strip = await screen.findByTestId('customers-kpi-strip');
    expect(strip.textContent).toContain('12');
    expect(strip.textContent).toContain('25%');
    expect(strip.textContent).toContain('13.533');
    expect(strip.textContent).toContain('216.530');
  });

  it('shows unknown — not zero — for a rate the server could not compute', async () => {
    mockApi(() =>
      listResponse({
        ...SUMMARY,
        buyers: 0,
        repeatBuyers: 0,
        repeatRate: null,
        orders: 0,
        avgOrderValue: null,
        totalSpent: 0,
      })
    );
    renderPage();
    const strip = await screen.findByTestId('customers-kpi-strip');
    expect(strip.textContent).toContain('unknown');
    expect(strip.textContent).not.toContain('0%');
  });

  it('shows every KPI as unknown when the list request failed', async () => {
    mockApi(() => ({ data: null, error: { message: 'down' } }));
    renderPage();
    const strip = await screen.findByTestId('customers-kpi-strip');
    expect(strip.textContent?.match(/unknown/g)).toHaveLength(4);
  });
});

describe('Customers page table + filters', () => {
  it('keeps the list to six columns and drops address / payment status', async () => {
    renderPage();
    await screen.findByText('Ahmed S');
    // DataTable renders the mobile card tree under jsdom (no matchMedia); the
    // address and last-payment status must not be anywhere on the list.
    expect(screen.queryByText('Block 1, Salmiya')).toBeNull();
    expect(screen.queryByText('paid')).toBeNull();
  });

  it('builds segment pills from the loaded snapshots and filters server-side', async () => {
    renderPage();
    const vip = await screen.findByRole('radio', { name: 'badges.vip' });
    // Only segments present in the loaded data get a pill (+ All, + Guest).
    expect(screen.queryByRole('radio', { name: 'badges.lost' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'badges.guest' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(vip);
    });
    await waitFor(() =>
      expect(
        api.apiGet.mock.calls.some(
          (call: unknown[]) =>
            String(call[0]).includes('/customers?') && String(call[0]).includes('segment=vip')
        )
      ).toBe(true)
    );
  });

  it('uses the shared debounced SearchInput and sends search server-side', async () => {
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'searchPlaceholder' });
    fireEvent.change(input, { target: { value: 'ahm' } });
    await waitFor(
      () =>
        expect(
          api.apiGet.mock.calls.some((call: unknown[]) => String(call[0]).includes('search=ahm'))
        ).toBe(true),
      { timeout: 2000 }
    );
  });
});
