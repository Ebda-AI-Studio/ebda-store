// @vitest-environment jsdom
/** 404-1 (admin): a calm line, the live search, the merchant's quick links and a way back to the site. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import NotFound from './not-found';

let pathname = '/stores/11111111-1111-4111-8111-111111111111/nope';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@/components/SettingsSearch', () => ({
  SettingsSearch: ({ storeId }: { storeId?: string }) => (
    <div role="search" data-store={storeId}>
      search
    </div>
  ),
}));

afterEach(cleanup);

describe('admin 404', () => {
  it('under a store: the line, the search for THAT store, and the merchant quick links', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('line');
    expect(screen.getByRole('search').getAttribute('data-store')).toBe(
      '11111111-1111-4111-8111-111111111111'
    );
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    for (const h of [
      '/dashboard',
      '/stores/11111111-1111-4111-8111-111111111111/products',
      '/stores/11111111-1111-4111-8111-111111111111/orders',
      '/stores/11111111-1111-4111-8111-111111111111/customers',
      '/stores',
      'https://ebda.app',
    ]) {
      expect(hrefs).toContain(h);
    }
  });

  it('outside a store: no store search, only dashboard and stores', () => {
    pathname = '/nope';
    render(<NotFound />);
    expect(screen.queryByRole('search')).toBeNull();
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(['/dashboard', '/stores', 'https://ebda.app']);
  });
});
