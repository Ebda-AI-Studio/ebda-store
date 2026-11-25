// @vitest-environment jsdom
/** The bell shows money/setup blockers from the shared attention feed and counts them in its badge. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useLocale: () => 'ar', useTranslations: () => (k: string) => k }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1' }),
  usePathname: () => '/stores/s1/orders',
  useRouter: () => ({ push: () => {} }),
}));
vi.mock('@/contexts/NotificationContext', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 1,
    isConnected: true,
    markAsRead: () => {},
    markAllAsRead: () => {},
    clearNotifications: () => {},
  }),
}));
const feed = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('../hooks/useAttention', () => ({
  useAttention: () => ({
    items: feed.items,
    actionCount: (feed.items as { severity: string }[]).filter(i => i.severity === 'action').length,
  }),
}));

import { NotificationBell } from './NotificationBell';

afterEach(cleanup);

describe('notification bell + attention', () => {
  it('badge = unread + action items; the dropdown lists the blockers with deep links', () => {
    feed.items = [
      {
        id: 'payments_failed',
        severity: 'action',
        section: 'orders',
        title: { en: 'Orders with a failed payment', ar: 'طلبات الدفع فيها فشل' },
        message: { en: '', ar: '' },
        count: 2,
      },
    ];
    render(<NotificationBell />);
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    const link = screen.getByText('طلبات الدفع فيها فشل').closest('a');
    expect(link?.getAttribute('href')).toBe('/stores/s1/orders');
  });
});
