// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/RowActions', () => ({
  RowActions: ({ items }: { items: Array<{ label: string }> }) => (
    <ul>
      {items.map(i => (
        <li key={i.label}>{i.label}</li>
      ))}
    </ul>
  ),
}));

import { ProductsToolbar } from './ProductsToolbar';

afterEach(cleanup);

describe('ProductsToolbar (IM1)', () => {
  it('shows a visible "import & export" link to /bulk beside "add product", not buried in the menu', () => {
    render(<ProductsToolbar storeId="s1" listUrl="/stores/s1/products" />);
    expect(screen.getByText('importExport').closest('a')?.getAttribute('href')).toBe(
      '/stores/s1/bulk'
    );
    expect(screen.getByText('addProduct').closest('a')?.getAttribute('href')).toContain(
      '/stores/s1/products/new'
    );
    expect(screen.queryByText('bulkImport')).toBeNull();
  });
});
