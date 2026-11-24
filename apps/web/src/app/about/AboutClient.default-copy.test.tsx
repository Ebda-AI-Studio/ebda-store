// @vitest-environment jsdom
/** STORE-QA-47: a store with no description still gets a real sentence, never a bare heading. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render } from '@testing-library/react';

const state = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  language: 'ar' as 'ar' | 'en',
}));
vi.mock('../../components/StoreLink', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../../components', () => ({
  ShopChrome: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CmsPageContent: ({ fallback }: { fallback: () => React.ReactNode }) => <>{fallback()}</>,
}));
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({ store: state.store }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: state.language,
    t: (en: string, ar: string) => (state.language === 'ar' ? ar : en),
  }),
}));

import AboutClient from './AboutClient';

afterEach(cleanup);

describe('AboutClient without a store description', () => {
  it('Arabic: a welcome sentence in Egyptian Arabic that names the store', () => {
    state.language = 'ar';
    state.store = { name: 'Amelia', nameAr: 'أميليا' };
    const { container } = render(<AboutClient />);
    const p = container.querySelector('p');
    expect(p?.textContent).toContain('أهلاً بيك في أميليا');
    expect(container.querySelector('h1')?.textContent).toBe('أميليا');
  });
  it('English: the English welcome sentence', () => {
    state.language = 'en';
    state.store = { name: 'Amelia' };
    const { container } = render(<AboutClient />);
    expect(container.querySelector('p')?.textContent).toContain('Welcome to Amelia.');
  });
  it('a real description wins over the default sentence', () => {
    state.language = 'en';
    state.store = { name: 'Amelia', description: 'Handmade gold.' };
    const { container } = render(<AboutClient />);
    expect(container.querySelector('p')?.textContent).toBe('Handmade gold.');
  });
});
