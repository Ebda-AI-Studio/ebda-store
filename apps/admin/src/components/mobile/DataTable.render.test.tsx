// @vitest-environment jsdom
/**
 * Regression for #134: the shared `DataTable` (every dense admin list —
 * orders, products, customers, coupons…) rendered a `<table>` with no
 * accessible name and `<th>` cells with no `scope="col"`. A screen reader
 * announced an unnamed table and could not associate a data cell with its
 * column header.
 *
 * These assertions are about the DESKTOP `<table>` tree specifically, and
 * jsdom has no `window.matchMedia` — DataTable's hook-driven desktop/mobile
 * switch (see its doc comment) falls back to the mobile card stack without
 * it, which would make `getByRole('table', …)` fail for reasons unrelated to
 * the accessibility regression this file guards. Mock `matchMedia(true)` the
 * same way `__tests__/DataTable.test.tsx` does to select the desktop tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DataTable, type DataTableColumn } from './DataTable';

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  // @ts-expect-error — test-only cleanup of a test-only global stub.
  delete window.matchMedia;
});

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [{ id: '1', name: 'Widget' }];
const columns: DataTableColumn<Row>[] = [
  { header: 'Name', cell: r => r.name },
  { header: 'ID', cell: r => r.id },
];

describe('DataTable accessibility', () => {
  it('applies aria-label to the desktop table when given', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={r => r.id} ariaLabel="Products" />);
    const table = screen.getByRole('table', { name: 'Products' });
    expect(table.getAttribute('aria-label')).toBe('Products');
  });

  it('gives every column header scope="col"', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={r => r.id} ariaLabel="Products" />);
    const table = screen.getByRole('table', { name: 'Products' });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.length).toBe(2);
    for (const h of headers) {
      expect(h.getAttribute('scope')).toBe('col');
    }
  });
});
