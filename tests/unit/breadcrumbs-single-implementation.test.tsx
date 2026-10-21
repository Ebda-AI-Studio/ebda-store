// @vitest-environment jsdom
/**
 * R-06 (Qamar taste audit 2026-10-15, quality-bar § 3): one Breadcrumbs component
 * everywhere. The PDP had a slash plus a chevron and no semantics, the PLP an
 * un-mirrored chevron, the cart and the two bundle pages their own copies, Dahab a
 * fourth. Now `apps/web/src/components/Breadcrumbs.tsx`:
 * `nav[aria-label] > ol > li`, separators aria-hidden, the current page
 * `aria-current="page"`, one chevron that mirrors in RTL.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: 'ar',
      direction: 'rtl',
      isRtl: true,
      setLanguage: () => {},
      t: (_en: string, ar: string) => ar,
    }),
  };
});

afterEach(cleanup);

const ROOT = join(__dirname, '../..');
const ONE = 'apps/web/src/components/Breadcrumbs.tsx';

describe('R-06: the Breadcrumbs component', () => {
  it('nav[aria-label] > ol > li, hidden mirrored separators, current page not a link', async () => {
    const { Breadcrumbs } = await import('../../apps/web/src/components/Breadcrumbs');
    const { container } = render(
      <div dir="rtl">
        <Breadcrumbs
          items={[
            { label: 'الرئيسية', href: '/' },
            { label: 'المنتجات', href: '/products' },
            { label: 'عباية كتان' },
          ]}
        />
      </div>
    );
    const nav = container.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('مسار التصفح');
    const items = nav.querySelectorAll(':scope > ol > li');
    expect(items).toHaveLength(3);
    const seps = nav.querySelectorAll('[data-breadcrumb-separator]');
    expect(seps).toHaveLength(2);
    seps.forEach(s => {
      expect(s.getAttribute('aria-hidden')).toBe('true');
      expect(s.getAttribute('class')).toContain('rtl:-scale-x-100');
    });
    // No slash separators, and the current page is the last li, not a link.
    expect(nav.textContent).not.toContain('/');
    const current = items[2].querySelector('[aria-current="page"]')!;
    expect(current.textContent).toBe('عباية كتان');
    expect(items[2].querySelector('a')).toBeNull();
    expect(items[0].querySelector('a')?.getAttribute('href')).toBe('/');
  });
});

describe('R-06: one breadcrumb implementation in the storefront', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  const files = walk(join(ROOT, 'apps/web/src')).map(f => relative(ROOT, f));
  const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

  it('the component exists', () => {
    expect(files).toContain(ONE);
  });

  it('no other file names a breadcrumb nav or builds a Home trail by hand', () => {
    const hits = files
      .filter(f => f !== ONE)
      .flatMap(f => {
        const src = read(f);
        const out: string[] = [];
        if (/aria-label=\{?[^>]*?(?:Breadcrumb|مسار الت)/.test(src))
          out.push(`${f}: breadcrumb aria-label`);
        // A hand-built trail: a Home link and a separator inside a <nav> in the same file.
        if (/t\('Home'/.test(src) && !/<Breadcrumbs\b/.test(src))
          out.push(`${f}: Home crumb outside <Breadcrumbs>`);
        return out;
      });
    expect(hits).toEqual([]);
  });

  it('the storefront never imports the unused @ebda/ui Breadcrumb (a second grammar)', () => {
    const hits = files.filter(f =>
      /import\s*\{[^}]*\bBreadcrumb\b[^}]*\}\s*from\s*'@ebda\/ui'/.test(read(f))
    );
    expect(hits).toEqual([]);
  });

  it('the PDP, PLP, cart, both bundle pages and the Dahab PDP use it', () => {
    for (const f of [
      'apps/web/src/app/products/[slug]/ProductDetailClient.tsx',
      'apps/web/src/app/products/ProductsClient.tsx',
      'apps/web/src/app/cart/CartClient.tsx',
      'apps/web/src/app/bundles/BundlesClient.tsx',
      'apps/web/src/app/bundles/[slug]/BundleDetailClient.tsx',
      'apps/web/src/templates/dahab/ProductDetail.tsx',
    ]) {
      expect(read(f), f).toMatch(/<Breadcrumbs\b/);
    }
  });
});

// a11y P2-10: crumb links measured 20px high. The hit area grows to 44px with a
// before: inset, so the trail keeps its visual height.
describe('rule (d): crumb links are 44px targets', () => {
  it('every crumb link clears 44px', async () => {
    const { smallTargets } = await import('../helpers/target-size');
    const { Breadcrumbs: B } = await import('../../apps/web/src/components/Breadcrumbs');
    const { container } = render(
      <B
        items={[{ label: 'Home', href: '/' }, { label: 'Abayas', href: '/c' }, { label: 'Linen' }]}
      />
    );
    expect(container.querySelectorAll('a').length).toBe(2);
    expect(smallTargets(container)).toEqual([]);
  });
});
