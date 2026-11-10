import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The returns page opens with the store's returns policy, and legal text is formal Arabic (Ruling
 * FU46-Y02b). Its heading is the title of that policy, so it is formal too: «المرتجعات واسترداد
 * الفلوس» put an Egyptian word over a formal body (pre-QA sweep finding 11, 2026-11-10).
 *
 * The formal body has a gate already (the `legal-register` fence in storefront-arabic-register).
 * This pins the two lines above the fence, which that gate reads as ordinary storefront copy.
 */

const ROOT = join(__dirname, '..', '..');
const RETURNS = readFileSync(join(ROOT, 'apps/web/src/app/returns/ReturnsClient.tsx'), 'utf8');
const LANGUAGE = readFileSync(join(ROOT, 'apps/web/src/contexts/LanguageContext.tsx'), 'utf8');

const HEADING = 'المرتجعات واسترداد الأموال';
/** Words that only Egyptian Arabic uses; none belongs in the title of a formal policy. */
const EGYPTIAN_ONLY = /(?:^|[^ء-ي])(الفلوس|فلوس|ده|دي|مش|عشان|لسه|بتاع\S*|إزاي)(?=$|[^ء-ي])/;

describe('returns page: the policy heading is in the same register as the policy', () => {
  it('the page heading is the formal one, in the page and in the shared translations', () => {
    expect(RETURNS).toContain(`t('Returns & Refunds', '${HEADING}')`);
    expect(LANGUAGE).toContain(`'Returns & Refunds': '${HEADING}'`);
  });

  it('nothing between the page heading and the formal policy body is Egyptian', () => {
    const start = RETURNS.indexOf("t('Returns & Refunds'");
    const fence = RETURNS.indexOf('legal-register:start', start);
    expect(start).toBeGreaterThan(-1);
    expect(fence).toBeGreaterThan(start);
    const intro = RETURNS.slice(start, fence);
    const arabic = intro.match(/'[^'\n]*[ء-ي][^'\n]*'/g) ?? [];
    expect(arabic.length).toBeGreaterThanOrEqual(2);
    expect(arabic.filter(s => EGYPTIAN_ONLY.test(s))).toEqual([]);
  });

  it('the Egyptian check can fail', () => {
    expect(EGYPTIAN_ONLY.test('المرتجعات واسترداد الفلوس')).toBe(true);
    expect(EGYPTIAN_ONLY.test(HEADING)).toBe(false);
    expect(EGYPTIAN_ONLY.test('سياسة إرجاع سهلة')).toBe(false);
  });
});
