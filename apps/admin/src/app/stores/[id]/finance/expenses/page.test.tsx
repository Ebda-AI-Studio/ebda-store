// @vitest-environment jsdom
/**
 * Issue 2443 — an Approve started on page 1 and resolved after the merchant paged to page 2
 * refetched through a `fetchExpenses` captured from the page-1 render, claimed the newest request
 * slot and repainted page-1 rows under a page-2 pager. The refetch must route through the effect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGetPage, apiPost, apiFetch, calls, posts } = vi.hoisted(() => ({
  apiGetPage: vi.fn(),
  apiPost: vi.fn(),
  apiFetch: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  posts: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({ apiGetPage, apiPost, apiFetch }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/lib/format', () => ({ minorToMajor: (n: number) => String(n) }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/DateRangePicker', () => ({ DateRangePicker: () => null }));
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

import ExpensesPage from './page';

const pageOf = (url: string) => Number(new URL(url, 'http://x').searchParams.get('page'));

function respond(d: Pending) {
  const page = pageOf(d.url);
  d.resolve({
    data: [
      {
        id: `e${page}`,
        expenseNumber: `EXP-PAGE-${page}`,
        expenseDate: '2026-02-01',
        supplier: null,
        expenseAccount: null,
        amount: 1,
        taxAmount: 0,
        totalAmount: 1,
        status: 'draft',
      },
    ],
    meta: { page, perPage: 50, total: 120, totalPages: 3 },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  posts.length = 0;
  apiGetPage.mockImplementation(
    (url: string) => new Promise(resolve => calls.push({ url, resolve }))
  );
  apiPost.mockImplementation((url: string) => new Promise(resolve => posts.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('expenses — post-action refetch reads the CURRENT page (issue 2443)', () => {
  it('an Approve resolving after the pager moved repaints the CURRENT page, not the stale one', async () => {
    render(<ExpensesPage />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => respond(calls[0]));
    await screen.findByText('EXP-PAGE-1');

    fireEvent.click(screen.getByText('actions.approve')); // POST in flight, started on page 1
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByLabelText('pager.next'));
    await waitFor(() => expect(calls).toHaveLength(2));

    await act(async () => posts[0].resolve({ error: null }));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    for (const c of calls.slice(1)) await act(async () => respond(c));

    expect(screen.getByText('EXP-PAGE-2')).toBeTruthy();
    expect(screen.queryByText('EXP-PAGE-1')).toBeNull();
    expect(pageOf(calls[calls.length - 1].url)).toBe(2);
  });
});

describe('expense receipts (private bucket, #739 review)', () => {
  const row = (receiptImageUrl: string | null) => ({
    data: [
      {
        id: 'e1',
        expenseNumber: 'EXP-1',
        expenseDate: '2026-02-01',
        supplier: null,
        expenseAccount: null,
        amount: 1,
        taxAmount: 0,
        totalAmount: 1,
        status: 'posted',
        receiptImageUrl,
      },
    ],
    meta: { page: 1, perPage: 50, total: 1, totalPages: 1 },
    error: null,
  });
  it('an uploaded (private) receipt opens through the authorised receipt endpoint, never as a public URL', async () => {
    apiGetPage.mockResolvedValue(row('private:stores/store-1/receipts/r.jpg'));
    apiFetch.mockResolvedValue(
      new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 })
    );
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab)
    );
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:receipt';
    render(<ExpensesPage />);
    fireEvent.click(await screen.findByText('actions.receipt'));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/stores/store-1/expenses/e1/receipt')
    );
    await waitFor(() => expect(tab.location.href).toBe('blob:receipt'));
    vi.unstubAllGlobals();
  });
  it('no receipt: no Receipt button', async () => {
    apiGetPage.mockResolvedValue(row(null));
    render(<ExpensesPage />);
    await screen.findByText('EXP-1');
    expect(screen.queryByText('actions.receipt')).toBeNull();
  });
});
