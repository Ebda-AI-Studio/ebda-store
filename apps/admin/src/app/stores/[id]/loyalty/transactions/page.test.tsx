// @vitest-environment jsdom
/**
 * Issues 2451 / 2443 — the customer-search submit did `setPage(1); fetchTransactions();` where the
 * explicit call used the PRE-reset closure (the page the merchant was on) and the reset then fired a
 * second request; with no stale guard whichever landed last painted, so page-3 rows could sit under
 * a page-1 pager. The submit now bumps a refreshKey and the fetch effect is latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, calls } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({ apiGet }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars && 'page' in vars ? `pager page ${vars.page}` : key,
}));
vi.mock('@/hooks/useRequireFeature', () => ({
  useRequireFeature: () => ({ enabled: true, isLoading: false, gate: null }),
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/mobile/DataTable', () => ({
  DataTable: ({
    rows,
    columns,
  }: {
    rows: Array<Record<string, unknown>>;
    columns: Array<{ cell: (r: Record<string, unknown>) => React.ReactNode }>;
  }) => (
    <div>
      {rows.map(r => (
        <div key={String(r.id)}>
          {columns.map((c, i) => (
            <span key={i}>{c.cell(r)}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

import LoyaltyTransactionsPage from './page';

const qp = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);

function respond(d: Pending) {
  const page = Number(qp(d.url, 'page'));
  const cust = qp(d.url, 'customerId') ?? 'any';
  d.resolve({
    data: {
      transactions: [
        {
          id: `t-${cust}-${page}`,
          type: 'earn_manual',
          points: 5,
          description: `TX-${cust}-${page}`,
          createdAt: '2026-02-01T00:00:00Z',
          expiresAt: null,
          customer: { firstName: 'A', lastName: 'B', email: null },
          order: null,
        },
      ],
      meta: { page, limit: 50, total: 250, totalPages: 5 },
    },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  apiGet.mockImplementation((url: string) => new Promise(resolve => calls.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function goToPage3() {
  render(<LoyaltyTransactionsPage />);
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => respond(calls[0]));
  await screen.findByText('TX-any-1');
  for (const n of [2, 3]) {
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(calls).toHaveLength(n));
    await act(async () => respond(calls[n - 1]));
    await screen.findByText(`TX-any-${n}`);
  }
}

describe('loyalty transactions — customer search is one request, latest wins (issues 2451, 2443)', () => {
  it('submitting a customer id from page 3 issues exactly ONE request, for page 1', async () => {
    await goToPage3();
    fireEvent.change(screen.getByLabelText('customerIdAriaLabel'), { target: { value: 'cust-9' } });
    fireEvent.click(screen.getByText('searchButton'));
    await waitFor(() => expect(calls).toHaveLength(4));
    await act(async () => {}); // let a would-be second (reset-page) request surface
    expect(calls).toHaveLength(4);
    expect(qp(calls[3].url, 'page')).toBe('1');
    expect(qp(calls[3].url, 'customerId')).toBe('cust-9');
  });

  it('an older page response landing last never paints under the newer page/pager', async () => {
    await goToPage3();
    fireEvent.click(screen.getByText('previous')); // page 2 in flight
    await waitFor(() => expect(calls).toHaveLength(4));
    fireEvent.click(screen.getByText('previous')); // page 1 in flight
    await waitFor(() => expect(calls).toHaveLength(5));

    await act(async () => respond(calls[4])); // page 1 first
    await act(async () => respond(calls[3])); // page 2 lands LAST

    expect(screen.getByText('TX-any-1')).toBeTruthy();
    expect(screen.queryByText('TX-any-2')).toBeNull();
    expect(screen.getByText('pager page 1')).toBeTruthy();
  });
});
