// @vitest-environment jsdom
/**
 * Analytics audit 2026-09-30 §4 — RFM segment cards drill down to the
 * Customers list filtered to that segment, and the recommended action follows
 * the admin's locale instead of always being English.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ locale: 'en', apiGet: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => h.locale };
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

import SegmentsPage from './page';

const DATA = {
  segments: [
    {
      segment: 'at_risk',
      count: 4,
      totalMonetaryFils: 40_000,
      recommendedAction: 'Send a win-back offer',
      recommendedActionAr: 'أرسل عرض استرجاع',
    },
    {
      segment: 'vip',
      count: 2,
      totalMonetaryFils: 90_000,
      recommendedAction: 'Reward them',
      recommendedActionAr: 'كافئهم',
    },
  ],
};

afterEach(() => {
  cleanup();
  h.locale = 'en';
  h.apiGet.mockReset();
});

describe('Insights → Segments drill-down', () => {
  it('each card links to the Customers list filtered to its segment', async () => {
    h.apiGet.mockResolvedValue({ data: DATA });
    render(<SegmentsPage />);
    await screen.findByText('Send a win-back offer');
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/stores/store-1/customers?segment=at_risk',
      '/stores/store-1/customers?segment=vip',
    ]);
  });

  it('renders the Arabic recommended action on the Arabic admin', async () => {
    h.locale = 'ar';
    h.apiGet.mockResolvedValue({ data: DATA });
    render(<SegmentsPage />);
    expect(await screen.findByText('أرسل عرض استرجاع')).toBeTruthy();
    expect(screen.queryByText('Send a win-back offer')).toBeNull();
  });
});
