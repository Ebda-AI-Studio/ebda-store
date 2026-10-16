// @vitest-environment jsdom
/**
 * S-01 (Qamar taste audit 2026-10-15, quality-bar § 8): every footer renders
 * the legal row — privacy · terms · returns · © — from `resolveBottomBar`.
 * The toggles were dead (0 callers): no footer linked a policy page at all.
 * Per footer (5 skins + Dahab; Qamar is a look on these skins): the 3 hrefs
 * are there when the toggles are on, and gone when they are off.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const ctx = vi.hoisted(() => ({ language: 'en' as 'en' | 'ar' }));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 'demo', name: 'Shop', theme: {}, settings: {} }, layout: {} }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  translations: {},
  useLanguage: () => ({
    language: ctx.language,
    isRtl: ctx.language === 'ar',
    t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
  }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { get: () => Promise.resolve({ success: false }) },
}));

import Minimal from '../../apps/web/src/templates/minimal/Footer';
import Classic from '../../apps/web/src/templates/classic/Footer';
import Modern from '../../apps/web/src/templates/modern/Footer';
import Elegant from '../../apps/web/src/templates/elegant/Footer';
import Bold from '../../apps/web/src/templates/bold/Footer';
import Dahab from '../../apps/web/src/templates/dahab/Footer';
import type { FooterProps } from '../../apps/web/src/templates/types';

const FOOTERS = {
  minimal: Minimal,
  classic: Classic,
  modern: Modern,
  elegant: Elegant,
  bold: Bold,
  dahab: Dahab,
};
const base: FooterProps = {
  branding: { name: 'Shop', nameAr: 'متجر' } as FooterProps['branding'],
  contact: {},
  socials: {},
  hidePoweredBy: true,
};

function legalHrefs(el: HTMLElement): string[] {
  const row = el.querySelector('[data-footer-legal]');
  return row ? [...row.querySelectorAll('a')].map(a => a.getAttribute('href') ?? '') : [];
}

afterEach(() => {
  cleanup();
  ctx.language = 'en';
});

describe.each(Object.entries(FOOTERS))('S-01: %s footer legal row', (_name, Footer) => {
  it('links privacy, terms and returns, and prints ©, by default', () => {
    const { container } = render(<Footer {...base} />);
    expect(legalHrefs(container)).toEqual(['/privacy', '/terms', '/returns']);
    expect(container.querySelector('[data-footer-legal]')!.textContent).toContain('© ');
  });

  it("paints in the skin's own footer-link ink, never the inherited body ink", () => {
    // Inherited ink vanished on a dark merchant footer (shot cart-1280-en-minimal, W1c).
    const { container } = render(<Footer {...base} />);
    const row = container.querySelector('[data-footer-legal]')!;
    expect(row.className).toMatch(
      /(?:^|\s)text-(?:muted-foreground|foreground\/\d+|background\/\d+)(?:\s|$)/
    );
  });

  it('drops each link whose merchant toggle is off', () => {
    const { container } = render(
      <Footer
        {...base}
        footerLinks={{
          bottomBar: { privacyEnabled: false, termsEnabled: false, returnsEnabled: false },
        }}
      />
    );
    expect(legalHrefs(container)).toEqual([]);
    // The © line stays while the bar itself is on.
    expect(container.querySelector('[data-footer-legal]')).not.toBeNull();
  });

  it('drops a link whose CMS page the merchant turned off', () => {
    const { container } = render(<Footer {...base} disabledCmsSlugs={['privacy']} />);
    expect(legalHrefs(container)).toEqual(['/terms', '/returns']);
  });

  it('renders nothing when the merchant turned the bar off', () => {
    const { container } = render(
      <Footer {...base} footerLinks={{ bottomBar: { enabled: false } }} />
    );
    expect(container.querySelector('[data-footer-legal]')).toBeNull();
  });

  it("points at the store's own pages (path prefix) and honours the © override, in Arabic", () => {
    ctx.language = 'ar';
    const { container } = render(
      <Footer
        {...base}
        isRtl
        urlPrefix="/s/shop"
        footerLinks={{ bottomBar: { copyrightOverrideAr: '© متجر ٢٠٢٦' } }}
      />
    );
    expect(legalHrefs(container)).toEqual(['/s/shop/privacy', '/s/shop/terms', '/s/shop/returns']);
    const row = container.querySelector('[data-footer-legal]')!;
    expect(row.textContent).toContain('الخصوصية');
    expect(row.textContent).toContain('© متجر ٢٠٢٦');
  });

  it('never repeats a policy link the merchant already put in a footer column', () => {
    const { container } = render(
      <Footer
        {...base}
        footerLinks={{
          company: [{ name: 'Privacy Policy', href: '/privacy', enabled: true }],
        }}
      />
    );
    expect(legalHrefs(container)).toEqual(['/terms', '/returns']);
    expect(container.querySelectorAll('a[href="/privacy"]').length).toBe(1);
  });
});
