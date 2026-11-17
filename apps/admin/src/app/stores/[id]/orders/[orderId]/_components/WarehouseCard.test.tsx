// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { WarehouseCard } from './WarehouseCard';
import type { OrderDetail } from './types';

const alloc = (orderItemId: string, warehouseCode: string, quantity: number) => ({
  orderItemId,
  productId: 'p1',
  variantId: null,
  warehouseId: `w-${warehouseCode}`,
  warehouseCode,
  quantity,
});
const order = (warehouseAllocations: ReturnType<typeof alloc>[]) =>
  ({
    items: [{ productId: 'p1', productName: 'Widget' }],
    warehouseAllocations,
  }) as unknown as OrderDetail;

afterEach(cleanup);

describe('WarehouseCard', () => {
  it('shows one row per line with every warehouse and its quantity when a line is split', () => {
    render(<WarehouseCard order={order([alloc('i1', 'A', 2), alloc('i1', 'B', 1)])} />);
    expect(screen.getAllByTestId('warehouse-split')).toHaveLength(1);
    expect(screen.getByTestId('warehouse-split').textContent).toBe('A x2, B x1');
    expect(screen.getByText('splitHint')).toBeTruthy();
  });
  it('a single-warehouse line has no split hint, and two lines stay two rows', () => {
    render(<WarehouseCard order={order([alloc('i1', 'A', 2), alloc('i2', 'B', 1)])} />);
    expect(screen.getAllByTestId('warehouse-split').map(e => e.textContent)).toEqual([
      'A x2',
      'B x1',
    ]);
    expect(screen.queryByText('splitHint')).toBeNull();
  });
  it('renders nothing without allocations', () => {
    const { container } = render(<WarehouseCard order={order([])} />);
    expect(container.textContent).toBe('');
  });
});
