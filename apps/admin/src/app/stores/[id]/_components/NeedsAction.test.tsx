// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../../../../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@ebda/ui', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { NeedsAction } from './NeedsAction';

const ok = (data: unknown) => Promise.resolve({ data, error: null });
const fail = () =>
  Promise.resolve({ data: null, error: { message: 'x', status: 500, code: 'SERVER_ERROR' } });

beforeEach(() => {
  apiGet.mockReset();
  cleanup();
});

describe('dashboard "needs action" row', () => {
  it('shows only the tiles with something waiting, linked to the right page', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/orders?')) return ok({ meta: { total: 3 } });
      if (url.includes('low-stock')) return ok({ products: [] });
      if (url.includes('returns/admin/stats')) return ok({ stats: { pending: 2 } });
      return ok({ meta: { total: 0 } });
    });
    render(<NeedsAction storeId="s1" />);
    await waitFor(() => expect(screen.getByText('orders')).toBeTruthy());
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('returns')).toBeTruthy();
    expect(screen.queryByText('lowStock')).toBeNull();
    expect(screen.queryByText('reviews')).toBeNull();
    expect(screen.getByText('orders').closest('a')?.getAttribute('href')).toBe(
      '/stores/s1/orders?status=pending'
    );
  });

  it('STORE-QA-29: an active store with empty SEO fields gets an SEO tile linking to /seo', async () => {
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/seo')
        ? ok({
            seo: { metaTitle: '', metaTitleAr: '', metaDescription: '', metaDescriptionAr: '' },
          })
        : ok({ meta: { total: 0 }, products: [], stats: { pending: 0 } })
    );
    render(<NeedsAction storeId="s1" />);
    await waitFor(() => expect(screen.getByText('seoMissing')).toBeTruthy());
    expect(screen.getByText('seoMissing').closest('a')?.getAttribute('href')).toBe(
      '/stores/s1/seo'
    );
  });

  it('no SEO tile once a title exists', async () => {
    apiGet.mockImplementation((url: string) =>
      url.endsWith('/seo')
        ? ok({ seo: { metaTitleAr: 'متجري' } })
        : ok({ meta: { total: 0 }, products: [], stats: { pending: 0 } })
    );
    render(<NeedsAction storeId="s1" />);
    await waitFor(() => expect(screen.getByText('allClear')).toBeTruthy());
    expect(screen.queryByText('seoMissing')).toBeNull();
  });

  it('says all clear when every count is zero', async () => {
    apiGet.mockImplementation(() =>
      ok({ meta: { total: 0 }, products: [], stats: { pending: 0 } })
    );
    render(<NeedsAction storeId="s1" />);
    await waitFor(() => expect(screen.getByText('allClear')).toBeTruthy());
  });

  it('shows ONE error tile with a retry when every read fails, never zeros', async () => {
    apiGet.mockImplementation(() => fail());
    render(<NeedsAction storeId="s1" />);
    await waitFor(() => expect(screen.getByText('loadFailed')).toBeTruthy());
    expect(screen.getByText('retry')).toBeTruthy();
    expect(screen.queryByText('allClear')).toBeNull();
  });

  it('one failing count (a plan without returns) hides that tile only', async () => {
    apiGet.mockImplementation((url: string) =>
      url.includes('returns/admin/stats') ? fail() : ok({ meta: { total: 1 }, products: [{}] })
    );
    render(<NeedsAction storeId="s1" />);
    await waitFor(() => expect(screen.getByText('orders')).toBeTruthy());
    expect(screen.queryByText('returns')).toBeNull();
    expect(screen.queryByText('loadFailed')).toBeNull();
  });
});
