import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let language: 'en' | 'ar' = 'ar';
let store: Record<string, unknown> = { name: 'Qamar Atelier', nameAr: 'أتيليه قمر', logo: null };
vi.mock('../contexts/StoreContext', () => ({
  useStore: () => ({ store }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../contexts/LanguageContext', () => ({ useLanguage: () => ({ language }) }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../templates/shared/StoreLogo', () => ({
  StoreLogo: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const { MinimalChrome } = await import('./MinimalChrome');
const html = () => renderToStaticMarkup(<MinimalChrome label="Secure Checkout">x</MinimalChrome>);

describe('MinimalChrome store name (checkout header)', () => {
  it('Arabic reader sees the Arabic name, as text and as logo alt', () => {
    language = 'ar';
    store = { name: 'Qamar Atelier', nameAr: 'أتيليه قمر', logo: null };
    expect(html()).toContain('أتيليه قمر');
    expect(html()).not.toContain('Qamar Atelier');
    store = { name: 'Qamar Atelier', nameAr: 'أتيليه قمر', logo: 'https://cdn.example/l.png' };
    expect(html()).toContain('alt="أتيليه قمر"');
  });
  it('English reader sees the canonical name; Arabic reader of a store with no Arabic name sees it too', () => {
    language = 'en';
    store = { name: 'Qamar Atelier', nameAr: 'أتيليه قمر', logo: null };
    expect(html()).toContain('Qamar Atelier');
    language = 'ar';
    store = { name: 'Qamar Atelier', nameAr: null, logo: null };
    expect(html()).toContain('Qamar Atelier');
  });
});
