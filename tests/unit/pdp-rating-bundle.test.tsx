// @vitest-environment jsdom
/**
 * Phase B3 Task 3 (Ruling B3-6): the two PDP merchandising lines. The rating line shows only with
 * a rating and never on a card; the bundle-saving line shows only with a live saving > 0 on a
 * store that has the `bundles` feature. With neither present the PDP gets NO extra markup.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { smallTargets } from '../helpers/target-size';

const ctx = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  language: 'ar' as 'en' | 'ar',
  getSavings: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => `/s${p}`,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: ctx.language,
      direction: ctx.language === 'ar' ? 'rtl' : 'ltr',
      isRtl: ctx.language === 'ar',
      setLanguage: () => {},
      t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
    }),
  };
});
vi.mock('../../apps/web/src/lib/api', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, api: { getBundleSavings: (...a: unknown[]) => ctx.getSavings(...a) } };
});

const { RatingSummary } = await import('../../apps/web/src/components/commerce/RatingSummary');
const { BundleSaving } = await import('../../apps/web/src/components/commerce/BundleSaving');

const root = path.resolve(__dirname, '../..');
const saving = (percent: number, over: Record<string, unknown> = {}) => ({
  bundleId: 'bun-1',
  slug: 'routine-bundle',
  name: 'Routine',
  nameAr: 'الروتين',
  price: 8500,
  componentSum: 10000,
  saving: 1500,
  percent,
  exact: false,
  ...over,
});
const setStore = (features: string[], language: 'ar' | 'en' = 'ar') => {
  ctx.language = language;
  ctx.store = { id: 'store-j', template: 'jasmine', enabledFeatures: features };
};
beforeEach(() => {
  setStore(['bundles']);
  ctx.getSavings = vi.fn(async () => ({ success: true, data: { savings: [] } }));
});
afterEach(cleanup);

describe('RatingSummary', () => {
  it('renders one inline line "★ 4.7 · 212 تقييم" that links to the reviews, a >= 44px target', () => {
    const { container } = render(<RatingSummary average={4.7} count={212} />);
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('#reviews');
    expect(a.textContent).toBe('★4.7· 212 تقييم');
    // label in name (2.5.3): it STARTS with the visible text
    expect(a.getAttribute('aria-label')).toBe('4.7 · 212 تقييم. من 5، اقرا التقييمات');
    expect(a.getAttribute('aria-label')!.startsWith('4.7 · 212')).toBe(true);
    expect(smallTargets(container, 44)).toEqual([]);
  });
  it('counted nouns follow the Arabic plural (one / two / few) and English', () => {
    expect(render(<RatingSummary average={5} count={1} />).container.textContent).toContain(
      'تقييم واحد'
    );
    cleanup();
    expect(render(<RatingSummary average={5} count={2} />).container.textContent).toContain(
      'تقييمين'
    );
    cleanup();
    expect(render(<RatingSummary average={4} count={5} />).container.textContent).toContain(
      '5 تقييمات'
    );
    cleanup();
    setStore([], 'en');
    expect(render(<RatingSummary average={4.2} count={1} />).container.textContent).toContain(
      '1 rating'
    );
  });
  it('renders NOTHING without reviews or without an average', () => {
    for (const [avg, n] of [
      [null, 0],
      [undefined, undefined],
      [4.5, 0],
      [null, 3],
      [0, 3],
    ] as const) {
      expect(
        render(<RatingSummary average={avg} count={n} />).container.innerHTML,
        `${avg}/${n}`
      ).toBe('');
      cleanup();
    }
  });
  it('the reviews anchor exists on the review section root (client-only, so SSR markup is unchanged)', () => {
    const src = readFileSync(path.join(root, 'apps/web/src/components/ReviewSection.tsx'), 'utf8');
    expect(src).toMatch(/<section id="reviews"/);
    const pdp = readFileSync(
      path.join(root, 'apps/web/src/app/products/[slug]/ProductDetailClient.tsx'),
      'utf8'
    );
    expect(pdp).toMatch(
      /dynamic\(\(\) => import\('..\/..\/..\/components\/ReviewSection'\), \{ ssr: false \}\)/
    );
  });
});

describe('BundleSaving', () => {
  it('renders ONE line "وفّر 15% لما تشتريه في باقة" linking to the bundle, from the live endpoint', async () => {
    ctx.getSavings = vi.fn(async () => ({ success: true, data: { savings: [saving(15)] } }));
    const { container } = render(<BundleSaving productId="prod-1" />);
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    expect(ctx.getSavings).toHaveBeenCalledWith('store-j', ['prod-1']);
    const a = container.querySelector('a')!;
    expect(a.textContent).toBe('وفّر 15% لما تشتريه في باقة');
    expect(a.getAttribute('href')).toBe('/s/bundles/routine-bundle');
    expect(smallTargets(container, 44)).toEqual([]);
  });
  it('English wording', async () => {
    setStore(['bundles'], 'en');
    ctx.getSavings = vi.fn(async () => ({ success: true, data: { savings: [saving(20)] } }));
    const { container } = render(<BundleSaving productId="prod-1" />);
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    expect(container.textContent).toBe('Save 20% when you buy it in a bundle');
  });
  it('renders nothing and makes NO request when the bundles feature is off', () => {
    setStore([]);
    const { container } = render(<BundleSaving productId="prod-1" />);
    expect(container.innerHTML).toBe('');
    expect(ctx.getSavings).not.toHaveBeenCalled();
  });
  it('renders nothing with no saving, on a failed request, and for a zero percent', async () => {
    const empty = render(<BundleSaving productId="p" />);
    await waitFor(() => expect(ctx.getSavings).toHaveBeenCalled());
    expect(empty.container.innerHTML).toBe('');
    cleanup();
    ctx.getSavings = vi.fn(async () => {
      throw new Error('down');
    });
    const failed = render(<BundleSaving productId="p" />);
    await waitFor(() => expect(ctx.getSavings).toHaveBeenCalled());
    expect(failed.container.innerHTML).toBe('');
    cleanup();
    ctx.getSavings = vi.fn(async () => ({ success: true, data: { savings: [saving(0)] } }));
    const zero = render(<BundleSaving productId="p" />);
    await waitFor(() => expect(ctx.getSavings).toHaveBeenCalled());
    expect(zero.container.innerHTML).toBe('');
  });
  it('never caches a saving in the page: a changed percent shows on the next mount', async () => {
    ctx.getSavings = vi.fn(async () => ({ success: true, data: { savings: [saving(10)] } }));
    const first = render(<BundleSaving productId="p" />);
    await waitFor(() => expect(first.container.textContent).toContain('10%'));
    cleanup();
    ctx.getSavings = vi.fn(async () => ({ success: true, data: { savings: [saving(25)] } }));
    const second = render(<BundleSaving productId="p" />);
    await waitFor(() => expect(second.container.textContent).toContain('25%'));
  });
});

describe('PDP markup is unchanged when neither line applies', () => {
  it('both components together add zero markup', () => {
    setStore([]);
    const { container } = render(
      <>
        <RatingSummary average={null} count={0} />
        <BundleSaving productId="p" />
      </>
    );
    expect(container.innerHTML).toBe('');
  });
  it('the PDP places them as bare siblings of the title and price (no wrapper element)', () => {
    const pdp = readFileSync(
      path.join(root, 'apps/web/src/app/products/[slug]/ProductDetailClient.tsx'),
      'utf8'
    );
    expect(pdp).toMatch(/<\/h1>\s*\{\/\*[^*]*\*\/\}\s*\{reviewsOn && \(\s*<RatingSummary/);
    // The automatic-promotion line (#1053) is a third bare sibling, between the bundle line and the B2B panel.
    expect(pdp).toMatch(
      /<BundleSaving productId=\{product\.id\} \/>\s*(?:<AutoPromotionLine productId=\{product\.id\} quantity=\{quantity\} \/>\s*)?<B2bPdpPanel/
    );
  });
  it('the rating line and the reviews block it links to share ONE condition (reviews switched off = no line, no dead #reviews link)', () => {
    const pdp = readFileSync(
      path.join(root, 'apps/web/src/app/products/[slug]/ProductDetailClient.tsx'),
      'utf8'
    );
    expect(pdp).toMatch(
      /const reviewsOn =\s*isEnabled\('reviews'\) &&\s*!!withPageSettings\(pageDoc, layout\)\?\.reviewSection\?\.enabled/
    );
    // ONE reviews slot of the page document, rendered by every skin (Ruling VE-12)
    expect(pdp.match(/reviewsOn && product \? \(/g)?.length).toBe(1);
    expect(pdp).toMatch(/\{reviewsOn && \(\s*<RatingSummary/);
    expect(pdp).toMatch(/ratingLine=\{\s*reviewsOn \?/); // the Dahab page, same condition
    // no ungated review block is left behind
    expect(pdp).not.toMatch(/isEnabled\('reviews'\) &&\s*layout\?\.reviewSection/);
  });
  it('a card carries no rating (Ruling B3-6): no card path imports RatingSummary', () => {
    for (const f of [
      'apps/web/src/templates/shared/StorefrontProductCard.tsx',
      'apps/web/src/templates/shared/ProductCarousel.tsx',
      'apps/web/src/templates/base/ProductCard.tsx',
      'apps/web/src/templates/dahab/ProductCard.tsx',
    ])
      expect(readFileSync(path.join(root, f), 'utf8'), f).not.toMatch(/RatingSummary|ratingStats/);
  });
});
