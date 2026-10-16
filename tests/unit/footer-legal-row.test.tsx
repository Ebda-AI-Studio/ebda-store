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

describe('FU46 I-1: the © year is the per-request render clock, not the local one', () => {
  it('prints the same year on a UTC server and a Cairo browser across the new-year boundary', async () => {
    const { RenderClockProvider } = await import('../../apps/web/src/contexts/RenderClockContext');
    const now = Date.UTC(2026, 11, 31, 22, 30); // 31 Dec 22:30 UTC = 1 Jan 00:30 in Cairo
    const years: string[] = [];
    const prevTz = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Africa/Cairo']) {
        process.env.TZ = tz;
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const { container, unmount } = render(
          <RenderClockProvider now={now}>
            <Minimal {...base} />
          </RenderClockProvider>
        );
        years.push(container.querySelector('[data-footer-legal] p')!.textContent!);
        unmount();
        vi.useRealTimers();
      }
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
      vi.useRealTimers();
    }
    expect(years[0]).toContain('© 2026');
    expect(years[1]).toBe(years[0]);
  });
});

// a11y P1-5 / rule (d) (W4): footer links, legal links and "Powered by" measured 16-24px high.
describe.each(Object.entries(FOOTERS))(
  'rule (d): %s footer targets are at least 44px',
  (_name, Footer) => {
    it('every link and button in the footer', async () => {
      const { smallTargets } = await import('../helpers/target-size');
      const { container } = render(
        <Footer
          {...base}
          hidePoweredBy={false}
          contact={{ whatsapp: '201012345678', email: 'a@b.co', phone: '01012345678' }}
          navigation={[{ label: 'Products', href: '/products' }] as never}
          footerLinks={{ columns: [] } as never}
        />
      );
      expect(smallTargets(container)).toEqual([]);
    });
  }
);

describe('rule (d): the cookie-preferences button under the footer is 44px', () => {
  it('the layout passes it a 44px hit box', async () => {
    const { readFileSync } = await import('node:fs');
    const { hitBox } = await import('../helpers/target-size');
    const src = readFileSync(
      require('node:path').resolve(__dirname, '../../apps/web/src/app/layout.tsx'),
      'utf8'
    );
    const cls = /<CookiePreferencesLink className="([^"]+)"/.exec(src)![1];
    const el = document.createElement('button');
    el.setAttribute('class', cls);
    expect(hitBox(el).h).toBeGreaterThanOrEqual(44);
  });
});
