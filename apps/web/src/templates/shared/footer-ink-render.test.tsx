import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contrastRatio, parseColorToRgb } from '@ebda/shared';
import type { FooterProps } from '../types';

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ isRtl: false, language: 'en', t: (en: string) => en }),
  translations: { Branches: 'Branches' } as Record<string, string>,
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
    prefetch: _prefetch,
    ...rest
  }: React.PropsWithChildren<{ href: string; prefetch?: boolean }>) =>
    React.createElement('a', { href, ...rest }, children),
}));
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's1', name: 'Test Store', slug: 'x', theme: {} },
    isLoading: false,
  }),
}));
vi.mock('../../lib/api', () => ({ api: { subscribeNewsletter: vi.fn() } }));

const FOOTERS = [
  ['classic', (await import('../classic/Footer')).default],
  ['modern', (await import('../modern/Footer')).default],
  ['minimal', (await import('../minimal/Footer')).default],
  ['bold', (await import('../bold/Footer')).default],
  ['elegant', (await import('../elegant/Footer')).default],
  ['dahab', (await import('../dahab/Footer')).default],
] as const;

// The four reviewer backgrounds plus the two the screenshots failed on (#7c3bed bold, #e92063 elegant).
const MERCHANT_BGS = ['#111111', '#1a2b4c', '#ffffff', '#f5efe6', '#7c3bed', '#e92063'];

function render(Footer: (typeof FOOTERS)[number][1], bgColor: string) {
  const props: FooterProps = {
    branding: { name: 'Test Store', nameAr: 'متجر تجريبي' },
    contact: { whatsapp: '+201001234567', email: 'a@b.co', phone: '+20100' },
    socials: {},
    navigation: [{ label: 'Shop', labelAr: 'تسوق', href: '/products' }],
    bgColor,
  };
  return renderToStaticMarkup(React.createElement(Footer as never, props as never));
}

const hexOf = (triplet: string) => {
  const rgb = parseColorToRgb(`hsl(${triplet})`)!;
  return '#' + [rgb.r, rgb.g, rgb.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
};

// Text colours the footer's ink re-scoping (footer-ink.ts + the [data-footer-ink] rules in
// globals.css) actually reaches: the two tokens, with or without an alpha, and inherit.
const REACHED =
  /^(?:[a-z-]+:)*text-(?:foreground(?:\/\d+)?|muted-foreground|current|inherit|primary)$/;
// Self-contained pairs: the control paints its own background (bg-primary + text-primary-foreground, or
// bg-foreground + text-background, whose --background is re-scoped to the opposite of the ink).
const PAIRED = new Set(['text-primary-foreground', 'text-background']);
const NOT_COLOUR =
  /^(?:[a-z-]+:)*text-(?:xs|sm|base|lg|xl|[2-9]xl|left|right|center|start|end|justify|wrap|nowrap|balance|pretty|ellipsis|clip|\[\d+(?:px|rem|em)\].*)$/;

describe('footer ink on a merchant-painted footer, every skin x every text role (B0-46 I-1)', () => {
  for (const [name, Footer] of FOOTERS) {
    describe(name, () => {
      it.each(MERCHANT_BGS)(
        '%s: ink + muted + background var clear 4.5:1 (links, copyright, legal row, whatsapp, name)',
        bg => {
          const html = render(Footer, bg);
          const root = /<footer[^>]*>/.exec(html)![0];
          expect(root).toContain('data-footer-ink');
          const style = /style="([^"]*)"/.exec(root)![1];
          const v = (k: string) => new RegExp(`(?:^|;\\s*)${k}:\\s*([^;]+)`).exec(style)![1].trim();
          expect(contrastRatio(bg, v('color'))).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(bg, hexOf(v('--foreground')))).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(bg, hexOf(v('--muted-foreground')))).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(bg, v('--footer-ink-muted'))).toBeGreaterThanOrEqual(4.5);
        }
      );
      it('every text colour class in the footer is one the ink re-scoping reaches', () => {
        const html = render(Footer, '#7c3bed');
        const stray = new Set<string>();
        for (const cls of html.matchAll(/class="([^"]*)"/g))
          for (const tok of cls[1].split(/\s+/))
            if (
              /(^|:)text-/.test(tok) &&
              !NOT_COLOUR.test(tok) &&
              !REACHED.test(tok) &&
              !PAIRED.has(tok)
            )
              stray.add(tok);
        expect([...stray]).toEqual([]);
      });
    });
  }
});
