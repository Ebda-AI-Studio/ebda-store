// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('./StoreLink', () => ({
  default: ({ href, children, ...r }: React.PropsWithChildren<{ href: string }>) =>
    React.createElement('a', { href, ...r }, children),
}));
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ isRtl: true, language: 'ar', t: (_e: string, a: string) => a }),
}));
vi.mock('../contexts/StoreContext', () => ({ useStoreUrl: () => (p: string) => p }));
vi.mock('../lib/api', () => ({
  api: {
    getCategories: () =>
      Promise.resolve({
        success: true,
        data: { categories: [{ id: '1', slug: 'a', name: 'A', nameAr: 'عبايات' }] },
      }),
    getProducts: vi.fn(),
  },
}));

import { EmptyStateKit } from './EmptyStateKit';

describe('EmptyStateKit (guest wishlist / search no-results)', () => {
  it('gives a title, a way out and this store categories, like the 404', async () => {
    render(<EmptyStateKit title="المفضلة فاضية" body="ابدأ" />);
    expect(screen.getByText('المفضلة فاضية')).toBeTruthy();
    expect(screen.getByText('تصفّح كل المنتجات').getAttribute('href')).toBe('/products');
    expect(screen.getByText('فاجئني')).toBeTruthy();
    expect(await screen.findByText('عبايات')).toBeTruthy();
  });
});
