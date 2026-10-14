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
    ["body[data-sticky-atc='1'] [data-toast-region]", '140px'],
    ["body[data-sticky-cart='1'] [data-toast-region]", '140px'],
    ["body[data-sticky-cart='blocked'] [data-toast-region]", '164px'],
  ])('%s lifts to %s, same as the floating widget', (selector, px) => {
    expect(blockFor(selector)).toContain(`bottom: calc(${px} + env(safe-area-inset-bottom))`);
    const widget = selector.replace('[data-toast-region]', "[data-floating-widget='bottom']");
    expect(blockFor(widget)).toBe(blockFor(selector));
  });

  it('the lift lives in the phone-only media block', () => {
    const media = css.indexOf('@media (max-width: 767px)', css.indexOf('Sticky mobile bars'));
    expect(media).toBeGreaterThan(-1);
    expect(css.indexOf("body[data-sticky-atc='1'] [data-toast-region]")).toBeGreaterThan(media);
  });
});
