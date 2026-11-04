// @vitest-environment jsdom
/**
 * Issue 2443 — a quantity save started on page 1 and resolved after the merchant paged refetched
 * through a `loadStock` captured from the page-1 render (old page/search) with no stale-response
 * guard, repainting page-1 rows under a page-2 pager. Writes now bump a refreshKey; the one stock
 * effect owns every request and is latest-wins. A search also resets the page in its handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiPut, apiPost, calls, puts } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
  puts: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('@/lib/api', () => ({ apiGet, apiPut, apiPost }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1', warehouseId: 'wh-1' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/hooks/useFeatures', () => ({ useFeatures: () => ({ isEnabled: () => false }) }));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/SearchInput', () => ({
  SearchInput: ({ onSearch }: { onSearch: (v: string) => void }) => (
    <input aria-label="search" onChange={e => onSearch(e.target.value)} />
  ),
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

import WarehouseStockPage from './page';

const stockCalls = () => calls.filter(c => c.url.includes('/stock?'));
const qp = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);

function respond(d: Pending) {
  const page = Number(qp(d.url, 'page'));
  const term = qp(d.url, 'search') ?? 'all';
  d.resolve({
    data: {
      rows: [
        {
          id: `r-${term}-${page}`,
          productId: 'p',
          variantId: null,
          quantity: 7,
          updatedAt: '2026-02-01T00:00:00Z',
          productName: `ROW-${term}-${page}`,
          productSku: null,
          variantTitle: null,
          variantSku: null,
        },
      ],
      total: 150,
    },
    error: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  puts.length = 0;
  apiGet.mockImplementation((url: string) => {
    if (url.includes('/stock?')) return new Promise(resolve => calls.push({ url, resolve }));
    return Promise.resolve({ data: null });
  });
  apiPut.mockImplementation((url: string) => new Promise(resolve => puts.push({ url, resolve })));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function loadFirstPage() {
  render(<WarehouseStockPage />);
  await waitFor(() => expect(stockCalls()).toHaveLength(1));
  await act(async () => respond(stockCalls()[0]));
  await screen.findByText('ROW-all-1');
}

describe('warehouse stock — refetch reads CURRENT page/search, latest wins (issue 2443)', () => {
  it('a quantity save resolving after the pager moved repaints the CURRENT page', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByText('7')); // enter edit mode
    fireEvent.click(screen.getByText('save')); // PUT in flight, started on page 1
    await waitFor(() => expect(puts).toHaveLength(1));
    fireEvent.click(screen.getByLabelText('pageNext'));
    await waitFor(() => expect(stockCalls()).toHaveLength(2));

    await act(async () => puts[0].resolve({ data: {} }));
    await waitFor(() => expect(stockCalls().length).toBeGreaterThanOrEqual(3));
    for (const c of stockCalls().slice(1)) await act(async () => respond(c));

    expect(screen.getByText('ROW-all-2')).toBeTruthy();
    expect(screen.queryByText('ROW-all-1')).toBeNull();
    expect(qp(stockCalls()[stockCalls().length - 1].url, 'page')).toBe('2');
  });

  it('a search from page 2 issues ONE request for page 1; an older response landing last never repaints', async () => {
    await loadFirstPage();
    fireEvent.click(screen.getByLabelText('pageNext'));
    await waitFor(() => expect(stockCalls()).toHaveLength(2));
    await act(async () => respond(stockCalls()[1]));
    await screen.findByText('ROW-all-2');

    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'mug' } });
    await waitFor(() => expect(stockCalls()).toHaveLength(3));
    await act(async () => {});
    expect(stockCalls()).toHaveLength(3);
    expect(qp(stockCalls()[2].url, 'page')).toBe('1');
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'mugs' } });
    await waitFor(() => expect(stockCalls()).toHaveLength(4));

    await act(async () => respond(stockCalls()[3])); // newest first
    await act(async () => respond(stockCalls()[2])); // older lands LAST

    expect(screen.getByText('ROW-mugs-1')).toBeTruthy();
    expect(screen.queryByText('ROW-mug-1')).toBeNull();
  });
});
