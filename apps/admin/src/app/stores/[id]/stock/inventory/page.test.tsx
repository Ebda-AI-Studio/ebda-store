// @vitest-environment jsdom
/**
 * Issue 2441 — the inventory list reset the page in a separate `useEffect(…, [search])` (a second
 * request that read the stale page) and had no stale-response guard, so a slower response for an
 * older search/page could land last. Retry also fetched from a handler closure. Now the search
 * handler resets the page, Retry bumps a refreshKey, and the one fetch effect is latest-wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Pending = { url: string; resolve: (v: unknown) => void };

const { apiGet, apiPost, calls } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  calls: [] as Array<{ url: string; resolve: (v: unknown) => void }>,
}));

vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/lib/api', () => ({ apiGet, apiPost }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars && 'page' in vars ? `page ${vars.page}` : key,
}));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/format', () => ({ formatPrice: (n: number) => String(n) }));
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

import StockInventoryPage from './page';

const param = (url: string, k: string) => new URL(url, 'http://x').searchParams.get(k);
const productCalls = () => calls.filter(c => c.url.includes('/products?'));

function respond(d: Pending) {
  const page = Number(param(d.url, 'page'));
  const term = param(d.url, 'search') ?? 'all';
  d.resolve({
    data: {
      products: [
        {
          id: `p-${term}-${page}`,
          name: `PROD-${term}-${page}`,
          sku: null,
          inventory: 5,
          lowStockThreshold: 1,
          allowBackorder: false,
          status: 'active',
          price: 1,
          costPrice: null,
          soldQuantity: 0,
        },
      ],
      meta: { total: 300, page, limit: 100, totalPages: 3 },
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

describe('inventory — one request per change, latest wins (issues 2441, 2443)', () => {
  it('a search from page 2 issues exactly ONE products request, for page 1', async () => {
    render(<StockInventoryPage />);
    await waitFor(() => expect(productCalls()).toHaveLength(1));
    await act(async () => respond(productCalls()[0]));
    await screen.findByText('PROD-all-1');
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => expect(productCalls()).toHaveLength(2));
    await act(async () => respond(productCalls()[1]));
    await screen.findByText('PROD-all-2');

    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'mug' } });
    await waitFor(() => expect(productCalls()).toHaveLength(3));
    await act(async () => {}); // let a would-be second (stale-page) request surface
    expect(productCalls()).toHaveLength(3);
    expect(param(productCalls()[2].url, 'search')).toBe('mug');
    expect(param(productCalls()[2].url, 'page')).toBe('1');
  });

  it('a slower response for an older search never repaints under the newer one', async () => {
    render(<StockInventoryPage />);
    await waitFor(() => expect(productCalls()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'mug' } });
    await waitFor(() => expect(productCalls()).toHaveLength(2));

    await act(async () => respond(productCalls()[1])); // newer first
    await act(async () => respond(productCalls()[0])); // older lands LAST

    expect(screen.getByText('PROD-mug-1')).toBeTruthy();
    expect(screen.queryByText('PROD-all-1')).toBeNull();
  });

  it('Retry resolving after the search changed does not repaint the old search', async () => {
    render(<StockInventoryPage />);
    await waitFor(() => expect(productCalls()).toHaveLength(1));
    await act(async () => productCalls()[0].resolve({ data: null, error: { message: 'boom' } }));
    fireEvent.click(await screen.findByText('retry')); // retry in flight for search ''
    await waitFor(() => expect(productCalls()).toHaveLength(2));
    expect(param(productCalls()[1].url, 'search')).toBeNull();

    fireEvent.change(screen.getByLabelText('search'), { target: { value: 'mug' } });
    await waitFor(() => expect(productCalls()).toHaveLength(3));
    await act(async () => respond(productCalls()[2]));
    await act(async () => respond(productCalls()[1])); // retry lands last

    expect(screen.getByText('PROD-mug-1')).toBeTruthy();
    expect(screen.queryByText('PROD-all-1')).toBeNull();
  });
});
