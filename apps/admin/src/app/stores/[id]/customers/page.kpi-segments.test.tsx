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
const nav = vi.hoisted(() => ({ query: '', replace: vi.fn() }));
const auth = vi.hoisted(() => ({ role: 'store_admin' }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: () => {}, replace: nav.replace }),
  usePathname: () => '/stores/store-1/customers',
  useSearchParams: () => new URLSearchParams(nav.query),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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
vi.mock('../../../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u', role: auth.role } }),
}));

import { ToastProvider } from '@ebda/ui';
import CustomersPage from './page';

const ROWS = [
  {
    id: 'u1',
    firstName: 'Ahmed',
    lastName: 'S',
    email: 'a@x.test',
    phone: '+201001234567',
    totalOrders: 3,
    totalSpent: 30000,
    avgOrderValue: 10000,
    lastOrderDate: '2026-09-01T00:00:00.000Z',
    isGuest: false,
    segment: 'vip',
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
      meta: {
        page: 1,
        perPage: 20,
        total: 1,
        totalPages: 1,
        truncated: false,
        summary,
        // Store-wide segments present — the API resolves them (guests included).
        segments: ['vip'],
      },
    },
  };
}

function mockApi(list: () => unknown) {
  api.apiGet.mockImplementation(() => Promise.resolve(list() as object));
}

function renderPage() {
  return render(
    <ToastProvider>
      <CustomersPage />
    </ToastProvider>
  );
}

beforeEach(() => {
  nav.query = '';
  auth.role = 'store_admin';
  mockApi(() => listResponse());
});
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
    expect(strip.textContent).toContain('135.33');
    expect(strip.textContent).toContain('2,165.30');
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

  it('builds segment pills from meta.segments and filters server-side', async () => {
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
    // …and the URL follows, so the filtered view survives a reload / back.
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith('/stores/store-1/customers?segment=vip', {
        scroll: false,
      })
    );
    // No second RFM round-trip: segments ride on the list response.
    expect(api.apiGet.mock.calls.some((c: unknown[]) => String(c[0]).includes('rfm-batch'))).toBe(
      false
    );
  });

  it('drill-down: ?segment= from an Insights segment card filters the first request', async () => {
    nav.query = 'segment=at_risk';
    renderPage();
    await screen.findByText('Ahmed S');
    const first = String(api.apiGet.mock.calls[0]?.[0]);
    expect(first).toContain('segment=at_risk');
    // The active segment keeps a pill even if the store has no member in it.
    expect(screen.getByRole('radio', { name: 'badges.at_risk' })).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('ignores an unknown ?segment= (unfiltered, like the API)', async () => {
    nav.query = 'segment=bogus';
    renderPage();
    await screen.findByText('Ahmed S');
    expect(String(api.apiGet.mock.calls[0]?.[0])).not.toContain('segment=');
  });

  it('badges a row from its server-resolved segment', async () => {
    renderPage();
    const row = await screen.findByText('Ahmed S');
    expect(row.parentElement?.textContent).toContain('badges.vip');
  });

  it('uses the shared debounced SearchInput and sends search server-side', async () => {
    renderPage();
    const input = await screen.findByRole('searchbox', { name: 'searchPlaceholder' });
    fireEvent.change(input, { target: { value: 'ahm' } });
    await waitFor(
      () =>
        expect(
          // the term rides in the X-Search-Query header, never the URL (Ruling SEARCH-P2-9)
          api.apiGet.mock.calls.some(
            (call: unknown[]) =>
              (call[1] as Record<string, string> | undefined)?.['X-Search-Query'] === 'ahm' &&
              !String(call[0]).includes('search=')
          )
        ).toBe(true),
      { timeout: 2000 }
    );
  });
});

describe('Customers page — segment filter integrity (#2222, #2234)', () => {
  it('?segment=guest keeps a reachable Guest pill even when the list request failed', async () => {
    nav.query = 'segment=guest';
    mockApi(() => ({ data: null, error: { code: 'X', message: 'boom', status: 500 } }));
    renderPage();
    const guest = await screen.findByRole('radio', { name: 'badges.guest' });
    // The filter is still applied, so the group must show and be tabbable.
    expect(guest.getAttribute('aria-checked')).toBe('true');
    expect(guest.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'segmentAll' })).toBeTruthy();
  });

  it('a segment change on page 3 sends ONE request, for page 1', async () => {
    mockApi(() => ({
      data: { ...listResponse().data, meta: { ...listResponse().data.meta, totalPages: 5 } },
    }));
    renderPage();
    await screen.findByText('Ahmed S');
    // Move to page 3 through the real pagination control.
    const next = () => screen.getAllByRole('button').find(b => /next/i.test(b.textContent ?? ''));
    await act(async () => {
      fireEvent.click(next()!);
    });
    await act(async () => {
      fireEvent.click(next()!);
    });
    await waitFor(() =>
      expect(api.apiGet.mock.calls.some((c: unknown[]) => String(c[0]).includes('page=3'))).toBe(
        true
      )
    );
    api.apiGet.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'badges.vip' }));
    });
    await waitFor(() => expect(api.apiGet).toHaveBeenCalled());
    const urls = api.apiGet.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.filter(u => u.includes('/customers?'))).toHaveLength(1);
    expect(urls[0]).toContain('page=1');
    expect(urls[0]).toContain('segment=vip');
  });

  it('a stale response that lands last does not overwrite the newer one', async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise(r => (release = r));
    let call = 0;
    api.apiGet.mockImplementation(() => {
      call += 1;
      // The first (older) request resolves LAST, with a different row.
      if (call === 1)
        return slow.then(() => ({
          data: {
            data: [{ ...ROWS[0], id: 'old', firstName: 'Stale' }],
            meta: listResponse().data.meta,
          },
        }));
      return Promise.resolve(listResponse());
    });
    renderPage();
    const input = await screen.findByRole('searchbox', { name: 'searchPlaceholder' });
    fireEvent.change(input, { target: { value: 'ahm' } });
    await screen.findByText('Ahmed S', {}, { timeout: 2000 });
    await act(async () => {
      release(null);
      await slow;
    });
    expect(screen.queryByText('Stale S')).toBeNull();
    expect(screen.getByText('Ahmed S')).toBeTruthy();
  });
});

describe('Customers page — erasure review banner (#2229)', () => {
  it('shows the manual-deletion instruction after an ambiguous erasure', async () => {
    nav.query = 'erasureReview=1';
    renderPage();
    await screen.findByText('Ahmed S');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('erasedCrmAmbiguous');
  });

  it('dismissing it drops the param and keeps the rest of the query', async () => {
    nav.query = 'erasureReview=1&segment=vip';
    renderPage();
    await screen.findByText('Ahmed S');
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(nav.replace).toHaveBeenCalledWith('/stores/store-1/customers?segment=vip', {
      scroll: false,
    });
  });

  it('is absent on a normal visit', async () => {
    renderPage();
    await screen.findByText('Ahmed S');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Customers page — export is an owner action (SEC-14)', () => {
  it('shows the Excel export to the owner', async () => {
    renderPage();
    await screen.findByTestId('customers-kpi-strip');
    // Export lives in the "..." menu (placement standard rule 2), not as a header button.
    fireEvent.click(screen.getByLabelText('moreMenu'));
    expect(screen.queryAllByRole('menuitem').map(b => b.textContent)).toContain('exportXlsx');
  });
  it('hides it from staff (the API answers 403 to them)', async () => {
    auth.role = 'staff';
    renderPage();
    await screen.findByTestId('customers-kpi-strip');
    expect(screen.queryByLabelText('moreMenu')).toBeNull();
    expect(screen.queryAllByRole('button').map(b => b.textContent)).not.toContain('exportXlsx');
  });
});
