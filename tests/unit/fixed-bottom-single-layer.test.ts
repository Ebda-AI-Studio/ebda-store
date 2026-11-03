/**
 * C-04 (Qamar taste audit 2026-10-15): at most ONE fixed-bottom layer on a phone.
 *
 * The PDP buy bar / Dahab pinned bar / cart total bar used to sit ON TOP of the
 * BottomTabBar, so two fixed bars (~130px) covered the PDP's first selector and
 * the cart's promo field. Now a task bar replaces the tab bar while it shows
 * (useStickyBarHeight marks <html data-task-bar>; globals.css hides the tab
 * bar), and every fixed bar feeds `html { scroll-padding-bottom }`.
 *
 * This file is the static half of the gate (the rules exist, in the phone
 * media block, and no component stacks a new bar on the tab bar). The DOM half
 * is StickyAddToCart.test.tsx (the flag + height on <html>), and the layout
 * half is `npm run test:fixed-bars` (scripts/visual/measure-fixed-bars.mjs,
 * real Chromium at 390 ar).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const R = join(__dirname, '../..');
const WEB = join(R, 'apps/web/src');
const css = readFileSync(join(WEB, 'styles/globals.css'), 'utf8');

/** The phone media block that holds the sticky-bar rules. */
function phoneBlock(): string {
  const start = css.indexOf('@media (max-width: 767px)', css.indexOf('Sticky mobile bars'));
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unterminated media block');
}
const decl = (block: string, selector: string) => {
  const i = block.indexOf(`${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return block.slice(i, block.indexOf('}', i)).replace(/\s+/g, ' ');
};

describe('C-04: one fixed-bottom layer, every bar feeds scroll-padding-bottom', () => {
  const block = phoneBlock();

  it('a task bar hides the tab bar', () => {
    expect(decl(block, 'html[data-task-bar] [data-bottom-tab-bar]')).toContain('display: none');
  });

  it('the tab bar feeds scroll-padding-bottom by default', () => {
    expect(decl(block, 'html')).toContain(
      'scroll-padding-bottom: calc(var(--bottom-tab-h) + env(safe-area-inset-bottom) + 0.75rem)'
    );
  });

  it('a task bar feeds it by its measured height instead', () => {
    expect(decl(block, 'html[data-task-bar]')).toContain(
      'scroll-padding-bottom: calc(var(--sticky-bar-h, 61px) + 0.75rem)'
    );
  });

  it('the tab bar carries the hook the rule targets', () => {
    expect(readFileSync(join(WEB, 'templates/shared/BottomTabBar.tsx'), 'utf8')).toContain(
      'data-bottom-tab-bar'
    );
  });

  it('no storefront component stacks a fixed bar on top of the tab bar', () => {
    // A fixed element lifted by the tab bar's height is a SECOND bottom layer.
    // Allowed: the cookie banner (a one-time consent dialog at z-100, not a
    // bar the page keeps) and the tab bar's own menu sheet padding.
    const ALLOW = new Set([
      'components/CookieConsentBanner.tsx',
      'templates/shared/BottomTabBar.tsx',
    ]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) {
          const rel = relative(WEB, p);
          if (ALLOW.has(rel)) continue;
          const src = readFileSync(p, 'utf8');
          if (/\bfixed\b[^"'`]*bottom-\[calc\(var\(--bottom-tab-h\)/.test(src)) offenders.push(rel);
        }
      }
    };
    walk(WEB);
    expect(offenders).toEqual([]);
  });

  it('a short page ends its footer above the bar: the shop wrapper subtracts the body reserve (audit #6)', () => {
    // The wrapper was min-h-screen with the body's pb-32 BELOW it, so on a short page the footer
    // sat at the viewport floor under the tab bar. Its min-height now subtracts --chrome-reserve,
    // and every body rule that changes the padding changes the variable with it.
    const chrome = readFileSync(join(WEB, 'components/ShopChrome.tsx'), 'utf8');
    expect(chrome.match(/min-h-\[calc\(100dvh-var\(--chrome-reserve,0px\)\)\]/g)?.length).toBe(2);
    expect(chrome).not.toMatch(/className="flex min-h-screen flex-col/);
    expect(decl(block, 'html')).toContain('--chrome-reserve: 8rem');
    expect(
      decl(
        block,
        "html[data-tab-bar='off'] body:not([data-sticky-atc='1']):not([data-sticky-cart])"
      )
    ).toContain('--chrome-reserve: 0px');
    expect(decl(block, "body[data-sticky-cart='1']")).toContain(
      '--chrome-reserve: calc(8rem + 4.25rem)'
    );
    expect(decl(block, "body[data-sticky-cart='blocked']")).toContain(
      '--chrome-reserve: calc(8rem + 4.25rem + 1.5rem)'
    );
  });

  it('the hook that marks the task bar is what every task bar uses', () => {
    const hook = readFileSync(join(WEB, 'components/commerce/useStickyBarHeight.ts'), 'utf8');
    expect(hook).toContain('root.dataset.taskBar');
    expect(hook).toContain("root.style.setProperty('--sticky-bar-h'");
  });
});
