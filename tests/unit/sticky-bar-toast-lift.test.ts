/**
 * F2 / UI rule 6 (two-trap recipe): every other fixed-bottom UI lifts above a sticky bar. The
 * toast region (@ebda/ui Toast, bottom 72px) sat on the sticky add-to-cart bar's name and price
 * at the exact moment the shopper used the bar. It must lift with the floating widget, under
 * every body flag the bars set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const R = join(__dirname, '../..');
const css = readFileSync(join(R, 'apps/web/src/styles/globals.css'), 'utf8');
const toast = readFileSync(join(R, 'packages/ui/src/components/Toast/index.tsx'), 'utf8');

/** The declaration block that applies to `selector` (first match). */
function blockFor(selector: string): string {
  const i = css.indexOf(selector);
  expect(i, `${selector} in globals.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', i);
  return css.slice(open, css.indexOf('}', open));
}

describe('toast lift above the sticky bars', () => {
  it('the toast container carries the data-toast-region hook', () => {
    expect(toast).toMatch(/data-toast-region\s/);
  });

  it.each([
    ["body[data-sticky-atc='1'] [data-toast-region]", '61px'],
    ["body[data-sticky-cart='1'] [data-toast-region]", '61px'],
    ["body[data-sticky-cart='blocked'] [data-toast-region]", '85px'],
  ])(
    '%s lifts by the measured bar height (fallback %s), same as the widget — no tab-bar term (C-04: the tab bar is hidden under a task bar)',
    (selector, px) => {
      const flat = blockFor(selector).replace(/\s+/g, ' ');
      expect(flat).toContain(`calc(var(--sticky-bar-h, ${px}) + 10px)`);
      expect(flat).not.toContain('--bottom-tab-h');
      const widget = selector.replace('[data-toast-region]', "[data-floating-widget='bottom']");
      expect(blockFor(widget)).toBe(blockFor(selector));
    }
  );

  it('the Dahab bar (73px) never overlaps the toast: the lift tracks the published height', () => {
    // The lift is the bar's own measured height (73 for Dahab, safe-area padding included)
    // + 10px, never a fixed guess (the old fixed 140 overlapped by ~2px, Minor 1).
    const dahabBar = 12 * 2 + 48 + 1;
    expect(dahabBar).toBe(73);
    const hook = readFileSync(
      join(R, 'apps/web/src/components/commerce/useStickyBarHeight.ts'),
      'utf8'
    );
    expect(hook).toContain("setProperty('--sticky-bar-h'");
    for (const f of [
      'apps/web/src/components/commerce/StickyAddToCart.tsx',
      'apps/web/src/components/commerce/StickyCartTotal.tsx',
      'apps/web/src/templates/dahab/ProductDetail.tsx',
    ]) {
      expect(readFileSync(join(R, f), 'utf8'), f).toContain('useStickyBarHeight(');
    }
  });

  it('the lift lives in the phone-only media block', () => {
    const media = css.indexOf('@media (max-width: 767px)', css.indexOf('Sticky mobile bars'));
    expect(media).toBeGreaterThan(-1);
    expect(css.indexOf("body[data-sticky-atc='1'] [data-toast-region]")).toBeGreaterThan(media);
  });
});
