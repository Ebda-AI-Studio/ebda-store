// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const auth = { isAuthenticated: false, isLoading: false };
const getOrders = vi.fn(async () => ({ success: true, data: { orders: [] } }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/api', () => ({ api: { getOrders: () => getOrders(), get: vi.fn() } }));
vi.mock('../../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 's' } }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (e: string) => e, language: 'en' }),
}));
vi.mock('../../../hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => String(n),
}));
vi.mock('../../../components/StoreLink', () => ({
  default: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/lib/format-date', () => ({ formatDate: () => '' }));
vi.mock('@/lib/order-labels', () => ({ orderStatusLabel: () => '' }));
import OrdersClient from './OrdersClient';

afterEach(() => {
  cleanup();
  getOrders.mockClear();
});

describe('STORE-QA-43 account orders makes no authed call for a guest', () => {
  it('guest: no /public/orders request (it would log a red 401)', () => {
    auth.isAuthenticated = false;
    render(<OrdersClient />);
    expect(getOrders).not.toHaveBeenCalled();
  });
  it('signed in: loads the orders', () => {
    auth.isAuthenticated = true;
    render(<OrdersClient />);
    expect(getOrders).toHaveBeenCalledTimes(1);
  });
});
