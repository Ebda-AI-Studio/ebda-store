// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', () => ({ apiGet: h.apiGet }));

import { ZeroResultSearchesCard } from './ZeroResultSearchesCard';

afterEach(() => {
  cleanup();
  h.apiGet.mockReset();
});

describe('ZeroResultSearchesCard', () => {
  it('lists the top no-result terms and links to the full page', async () => {
    h.apiGet.mockResolvedValue({
      data: {
        days: 7,
        totals: { searches: 4, zeroResultSearches: 4, zeroResultRate: 1 },
        terms: [{ term: 'كوتشي', searches: 4, zeroResults: 4, lastResultCount: 0 }],
      },
    });
    render(<ZeroResultSearchesCard storeId="store-1" />);
    expect(await screen.findByText('كوتشي')).toBeTruthy();
    expect(h.apiGet).toHaveBeenCalledWith(
      '/api/v1/stores/store-1/search-insights?days=7&filter=zero'
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe('/stores/store-1/insights/searches');
  });

  it('says so when there are none, and says it failed instead of showing an empty list', async () => {
    h.apiGet.mockResolvedValue({
      data: {
        days: 7,
        totals: { searches: 0, zeroResultSearches: 0, zeroResultRate: null },
        terms: [],
      },
    });
    render(<ZeroResultSearchesCard storeId="store-1" />);
    expect(await screen.findByText('cardEmpty')).toBeTruthy();
    expect(screen.getByText('floorNote')).toBeTruthy(); // the ≥2 floor is explained on the card too
    cleanup();
    h.apiGet.mockResolvedValue({ error: { message: 'x' } });
    render(<ZeroResultSearchesCard storeId="store-1" />);
    expect(await screen.findByText('loadFailed')).toBeTruthy();
  });
});
