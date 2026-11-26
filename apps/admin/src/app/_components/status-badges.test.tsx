// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import en from '../../i18n/messages/en.json';
import ar from '../../i18n/messages/ar.json';

let locale: 'en' | 'ar' = 'ar';
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (k: string) => {
    let o: unknown = (locale === 'ar' ? ar : en) as unknown;
    for (const part of `${ns}.${k}`.split('.')) o = (o as Record<string, unknown>)?.[part];
    return typeof o === 'string' ? o : k;
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@ebda/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock('../../lib/format', () => ({ formatPrice: String, formatDate: String }));

import { RecentOrders } from './RecentOrders';
import { RecentStores } from './RecentStores';

afterEach(cleanup);

describe('platform dashboard status badges', () => {
  it('shows Arabic order status, never the raw enum', () => {
    locale = 'ar';
    render(
      <RecentOrders
        isLoading={false}
        storeName={null}
        orders={[
          {
            id: 'abcdef123',
            orderNumber: 'A-1',
            status: 'delivered',
            total: 100,
            customer: { firstName: 'a', lastName: 'b' },
            store: { name: 'S' },
          } as never,
        ]}
      />
    );
    expect(screen.getByText('تم التسليم')).toBeTruthy();
    expect(screen.queryByText('delivered')).toBeNull();
  });

  it('shows Arabic store status, never the raw enum', () => {
    locale = 'ar';
    render(
      <RecentStores
        isLoading={false}
        stores={[
          {
            id: 's1',
            name: 'متجر',
            slug: 's',
            status: 'active',
            createdAt: '2026-01-01',
          } as never,
        ]}
      />
    );
    expect(screen.getByText('نشط')).toBeTruthy();
    expect(screen.queryByText('active')).toBeNull();
  });
});
