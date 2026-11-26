// @vitest-environment jsdom
/** Phone bottom bar: Orders and More carry the attention counts from the shared feed; none when clean. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/stores/s1' }));

import { MobileBottomNav } from './MobileBottomNav';
import { attentionNavBadges } from '@ebda/shared';

afterEach(cleanup);

describe('MobileBottomNav attention badges', () => {
  it('shows the Orders count on the Orders tab and the settings count on More', async () => {
    render(<MobileBottomNav storeId="s1" onOpenMore={() => {}} badges={{ orders: 3, more: 2 }} />);
    const badges = await screen.findAllByTestId('attention-badge');
    expect(badges.map(b => b.textContent)).toEqual(['3', '2']);
    expect(badges[0].closest('a')?.getAttribute('href')).toBe('/stores/s1/orders');
    expect(screen.getByRole('button', { name: /more/ }).getAttribute('aria-label')).toContain(
      'badge'
    );
  });
  it('no badge when nothing needs action', async () => {
    render(<MobileBottomNav storeId="s1" onOpenMore={() => {}} badges={{ orders: 0, more: 0 }} />);
    await screen.findByRole('navigation');
    expect(screen.queryByTestId('attention-badge')).toBeNull();
  });
});

describe('attentionNavBadges', () => {
  const item = (section: string, severity: 'action' | 'info', count?: number) =>
    ({
      id: 'x',
      severity,
      section,
      title: { en: '', ar: '' },
      message: { en: '', ar: '' },
      count,
    }) as never;
  it('splits order-money from settings and ignores info', () => {
    expect(
      attentionNavBadges([
        item('orders', 'action', 4),
        item('orders', 'action'),
        item('domain', 'action'),
        item('billing', 'action'),
        item('staff', 'info', 2),
      ])
    ).toEqual({ orders: 5, settings: 2 });
  });
});
