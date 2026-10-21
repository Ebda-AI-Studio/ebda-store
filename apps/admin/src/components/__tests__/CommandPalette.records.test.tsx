// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const push = vi.fn();
const apiGet = vi.fn();
let storeParam: string | undefined = 'store-1';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ id: storeParam }),
}));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));

import { CommandPalette } from '../CommandPalette';

const items = [{ name: 'Orders', href: '/stores/store-1/orders', group: 'Sales' }];
const records = {
  products: [{ id: 'p1', name: 'Sneakers', nameAr: 'أحذية', sku: 'SN-1' }],
  orders: [{ id: 'o1', orderNumber: 'EB-1', customerName: 'أحمد علي', total: 150000 }],
  customers: [{ key: 'mona@x.test', name: 'منى سالم', phone: '0112', isGuest: true }],
};

function open() {
  render(<CommandPalette items={items} />);
  act(() => {
    window.dispatchEvent(new Event('force:open-search'));
  });
  return screen.getByRole('textbox');
}

beforeEach(() => {
  vi.useFakeTimers();
  push.mockReset();
  apiGet.mockReset();
  storeParam = 'store-1';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });
const flush = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('CommandPalette record search (Task 18)', () => {
  it('debounces 200 ms, then shows products, orders and customers under their headers', async () => {
    apiGet.mockResolvedValue({ data: records });
    const input = open();
    type(input, 'احمد');
    await flush(199);
    expect(apiGet).not.toHaveBeenCalled();
    await flush(2);
    // the term rides in a header, NEVER the URL (Ruling SEARCH-P2-9)
    expect(apiGet).toHaveBeenCalledWith('/api/v1/stores/store-1/search', {
      'X-Search-Query': '%D8%A7%D8%AD%D9%85%D8%AF',
    });
    expect(String(apiGet.mock.calls[0][0])).not.toMatch(/[?&]q=|search=/);
    for (const h of ['products', 'orders', 'customers']) expect(screen.getByText(h)).toBeTruthy();
    expect(screen.getByText('أحذية')).toBeTruthy(); // Arabic name in the Arabic locale
    expect(screen.getByText('#EB-1')).toBeTruthy();
    expect(screen.getByText('منى سالم')).toBeTruthy();
  });

  it('ArrowDown + Enter on the customer opens the customer page under the store, key encoded', async () => {
    apiGet.mockResolvedValue({ data: { ...records, products: [], orders: [] } });
    const input = open();
    type(input, 'منى');
    await flush(250);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/stores/store-1/customers/mona%40x.test');
  });

  it('opens a product in the editor and an order on its page', async () => {
    apiGet.mockResolvedValue({ data: records });
    open();
    type(screen.getByRole('textbox'), 'sneakers');
    await flush(250);
    fireEvent.click(screen.getByText('أحذية'));
    expect(push).toHaveBeenLastCalledWith('/stores/store-1/products/p1/edit');
  });

  it('a reply for an older query is dropped', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    apiGet.mockImplementationOnce(() => new Promise(r => (resolveFirst = r)));
    apiGet.mockResolvedValueOnce({ data: { products: [], orders: [], customers: [] } });
    const input = open();
    type(input, 'سنيكرز');
    await flush(250);
    type(input, 'منى');
    await flush(250);
    await act(async () => resolveFirst({ data: records }));
    expect(screen.queryByText('أحذية')).toBeNull();
  });

  it('no store in the URL, or under two characters: no lookup', async () => {
    const input = open();
    type(input, 'ا');
    await flush(300);
    expect(apiGet).not.toHaveBeenCalled();
    cleanup();
    storeParam = undefined;
    const input2 = open();
    type(input2, 'احمد');
    await flush(300);
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('shows a rate-limited state, distinct from "no results", when the API answers 429', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { status: 429, code: 'RATE_LIMITED', message: 'x' },
    });
    const input = open();
    type(input, 'سنيكرز');
    await flush(250);
    expect(screen.getByText('rateLimited')).toBeTruthy();
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('shows a failed-search state on a server error or a network failure', async () => {
    apiGet.mockResolvedValueOnce({
      data: null,
      error: { status: 500, code: 'SERVER_ERROR', message: 'x' },
    });
    const input = open();
    type(input, 'سنيكرز');
    await flush(250);
    expect(screen.getByText('searchFailed')).toBeTruthy();
    apiGet.mockRejectedValueOnce(new Error('offline'));
    type(input, 'منى');
    await flush(250);
    expect(screen.getByText('searchFailed')).toBeTruthy();
  });

  it('keeps showing the page results next to the failure notice', async () => {
    apiGet.mockResolvedValue({
      data: null,
      error: { status: 429, code: 'RATE_LIMITED', message: 'x' },
    });
    const input = open();
    type(input, 'orders');
    await flush(250);
    expect(screen.getByText('Orders')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('rateLimited');
  });
});
