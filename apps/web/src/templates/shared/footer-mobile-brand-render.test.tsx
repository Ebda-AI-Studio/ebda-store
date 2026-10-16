import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FooterProps } from '../types';

let currentIsRtl = false;
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    isRtl: currentIsRtl,
    language: currentIsRtl ? 'ar' : 'en',
    t: (en: string, ar?: string) => (currentIsRtl ? (ar ?? en) : en),
  }),
  translations: { Branches: 'فروعنا' } as Record<string, string>,
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) =>
    React.createElement('img', { src, alt }),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    prefetch: _p,
    ...rest
  }: React.PropsWithChildren<{ href: string; prefetch?: boolean }>) =>
    React.createElement('a', { href, ...rest }, children),
}));
vi.mock('../../lib/api', () => ({ api: { subscribeNewsletter: vi.fn() } }));

const FOOTERS = [
  ['classic', (await import('../classic/Footer')).default],
  ['modern', (await import('../modern/Footer')).default],
  ['minimal', (await import('../minimal/Footer')).default],
  ['bold', (await import('../bold/Footer')).default],
  ['elegant', (await import('../elegant/Footer')).default],
] as const;

const BRANDING = { name: 'Test Store', nameAr: 'متجر تجريبي' };
function render(Footer: (typeof FOOTERS)[number][1], props: Partial<FooterProps>, isRtl = false) {
  currentIsRtl = isRtl;
  const base: FooterProps = { branding: BRANDING, contact: {}, socials: {}, navigation: [] };
  return renderToStaticMarkup(React.createElement(Footer as never, { ...base, ...props } as never));
}
const MOBILE = /data-footer-brand="mobile"[^>]*>([^<]*)</;

describe('footer brand on phones when the store has no logo (B0-46)', () => {
  it.each(FOOTERS)('%s: no logo → the store name renders below md', (_n, Footer) => {
    expect(MOBILE.exec(render(Footer, {}))?.[1]).toBe('Test Store');
    expect(MOBILE.exec(render(Footer, {}, true))?.[1]).toBe('متجر تجريبي');
  });
  it.each(FOOTERS)('%s: a logo, or hideFooterLogoMobile, renders no mobile name', (_n, Footer) => {
    expect(
      render(Footer, { branding: { ...BRANDING, logo: 'https://cdn.example/l.png' } })
    ).not.toContain('data-footer-brand="mobile"');
    expect(render(Footer, { hideFooterLogoMobile: true })).not.toContain(
      'data-footer-brand="mobile"'
    );
  });
});
