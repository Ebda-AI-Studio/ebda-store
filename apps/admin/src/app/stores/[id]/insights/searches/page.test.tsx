// @vitest-environment jsdom
/**
 * Search program Task 6: the "What shoppers searched" page renders the terms the API returns,
 * links each to the product search pre-filled, shows an unknown rate as "—" (never 0%), and
 * keeps an honest empty state that explains the ≥2 floor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/api', () => ({ apiGet: h.apiGet }));

import SearchesPage from './page';

const WITH_TERMS = {
  days: 30,
  totals: { searches: 5, zeroResultSearches: 3, zeroResultRate: 0.6 },
  terms: [
    { term: 'كوتشي', searches: 3, zeroResults: 3, lastResultCount: 0 },
    { term: 'تيشرت', searches: 2, zeroResults: 0, lastResultCount: 4 },
  ],
};
const NOTHING = {
  days: 30,
  totals: { searches: 0, zeroResultSearches: 0, zeroResultRate: null },
  terms: [],
};

afterEach(() => {
  cleanup();
  h.apiGet.mockReset();
});

describe('Insights → Searches page', () => {
  it('renders the returned terms, each linking to the product search pre-filled', async () => {
    h.apiGet.mockResolvedValue({ data: WITH_TERMS });
    render(<SearchesPage />);
    await screen.findAllByText('كوتشي');
    expect(h.apiGet).toHaveBeenCalledWith(
      '/api/v1/stores/store-1/search-insights?days=30&filter=zero'
    );
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toContain(`/stores/store-1/products?q=${encodeURIComponent('كوتشي')}`);
    expect(hrefs).toContain(`/stores/store-1/products?q=${encodeURIComponent('تيشرت')}`);
    // Latin digits (NUMERALS-1) and a rounded percentage.
    expect(screen.getByText('60%')).toBeTruthy();
    // "add as search word" only on a term that had zero results.
    expect(screen.getAllByText('addTerm')).toHaveLength(1);
  });

  it('shows — (not 0%) when the rate is unknown, plus an honest empty state with the floor note', async () => {
    h.apiGet.mockResolvedValue({ data: NOTHING });
    render(<SearchesPage />);
    expect(await screen.findByText('empty')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.getByText('floorNote')).toBeTruthy();
  });

  it('refetches when the period or the filter changes', async () => {
    h.apiGet.mockResolvedValue({ data: WITH_TERMS });
    render(<SearchesPage />);
    await screen.findAllByText('كوتشي');
    fireEvent.click(screen.getByText('days7'));
    await waitFor(() =>
      expect(h.apiGet).toHaveBeenLastCalledWith(
        '/api/v1/stores/store-1/search-insights?days=7&filter=zero'
      )
    );
    fireEvent.click(screen.getByText('all'));
    await waitFor(() =>
      expect(h.apiGet).toHaveBeenLastCalledWith(
        '/api/v1/stores/store-1/search-insights?days=7&filter=all'
      )
    );
  });
});
