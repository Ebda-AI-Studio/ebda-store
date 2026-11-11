import { describe, expect, it } from 'vitest';
import { COPY } from '../../apps/marketing/src/lib/content';
import { MONTHLY_FEE_EGP, POSITIONING } from '../../apps/marketing/src/lib/positioning';
import { BRAND } from '../../packages/shared/src/brand';

/** Ruling POSITION-1: one hero line states the eliminated monthly cost, from one set of numbers, naming no competitor. */
describe('home positioning line', () => {
  it('the arithmetic holds: 50,000 EGP x 1% = 500 EGP', () => {
    expect(POSITIONING.monthlyOrdersEgp).toBe(50_000);
    expect(POSITIONING.otherPlatformFeePct).toBe(1);
    expect(MONTHLY_FEE_EGP).toBe(500);
    expect((50_000 * 1) / 100).toBe(MONTHLY_FEE_EGP);
  });

  it('English copy is exactly the approved sentence', () => {
    expect(COPY.en.hero.saving).toBe(
      'No commission on your sales. With 50,000 EGP of orders a month, a 1% fee on online orders on some platforms costs you 500 EGP every month. With Ebda Store, 0.'
    );
  });

  it("Arabic copy says the same numbers, in the brand's exact Arabic product name, in the same order", () => {
    const ar = COPY.ar.hero.saving;
    expect(ar).toContain(BRAND.product.nameAr);
    expect(ar).toContain('50 ألف جنيه');
    expect(ar).toContain('1%');
    expect(ar).toContain('500 جنيه');
    expect(ar).toMatch(/^من غير عمولة على مبيعاتك\./);
    expect(ar).toMatch(/صفر\.$/);
  });

  it('names no competitor and no provider', () => {
    for (const l of ['ar', 'en'] as const)
      expect(COPY[l].hero.saving).not.toMatch(
        /shopify|salla|zid|wuilt|youcan|easyorders|expandcart|woocommerce|سلة|زد|شوبيفاي|ويلت|يوكان|إيزي أوردرز/i
      );
  });
});
