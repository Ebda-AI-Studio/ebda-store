// @vitest-environment jsdom
/**
 * a11y re-audit P1-N3 + P2-N6: the empty cart's only action ("ابدأ التسوق ←" / "Start Shopping →")
 * measured 73-109 x 25 and drew its direction as a literal glyph. Every skin's EmptyState CTA is a
 * 44px target, its arrow (if any) is the one mirroring icon (rtl:-scale-x-100), never ← or →.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { smallTargets } from '../helpers/target-size';

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_e: string, a: string) => a }),
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { theme: {}, look: null }, layout: null }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ({}),
}));

const T = '../../apps/web/src/templates';
const SKINS = ['minimal', 'modern', 'classic', 'elegant', 'bold', 'dahab'];
afterEach(cleanup);

describe.each(SKINS)('%s EmptyState CTA', skin => {
  it.each([true, false])('rtl=%s: 44px, no glyph arrow', async isRtl => {
    const { default: EmptyState } = await import(`${T}/${skin}/EmptyState.tsx`);
    const { container } = render(
      <EmptyState
        title="Your cart is empty"
        titleAr="سلة التسوق فاضية"
        ctaLabel="Start shopping"
        ctaLabelAr="ابدأ التسوق"
        ctaHref="/products"
        isRtl={isRtl}
        rtlPolish
      />
    );
    expect(smallTargets(container, 44)).toEqual([]);
    expect(container.textContent).not.toMatch(/[←→]/);
  });
});

describe('the cart page "Continue shopping" link is a 44px target (P1-N3)', () => {
  it('measured 97-151 x 20; it is now a 44px inline-flex row', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../apps/web/src/app/cart/CartClient.tsx'), 'utf8');
    const i = src.indexOf("'Continue shopping'");
    const link = src.slice(src.lastIndexOf('<Link', i), i);
    expect(link).toMatch(/className="inline-flex min-h-11 items-center/);
  });
});
