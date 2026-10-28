/**
 * IA-10 (independent audit): on a phone the header hamburger and the tab bar's
 * "القائمة" (menu) opened the same navigation. Where the tab bar shows, the
 * header drops its menu button; where the tab bar hides (checkout, auth, order
 * detail) or above md, the header keeps it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tabBarShownOn,
  HEADER_MENU_WITH_TAB_BAR,
} from '../../apps/web/src/templates/shared/tab-bar-visibility';

describe('one mobile menu', () => {
  it('the tab bar shows on shopping routes and hides mid-purchase', () => {
    expect(tabBarShownOn('/')).toBe(true);
    expect(tabBarShownOn('/s/qamar/products/linen-abaya')).toBe(true);
    expect(tabBarShownOn('/checkout')).toBe(false);
    expect(tabBarShownOn('/s/qamar/auth/login')).toBe(false);
    expect(tabBarShownOn('/account/orders/abc')).toBe(false);
  });

  it.each(['base', 'dahab'])(
    '%s header hides its menu button below md when the tab bar shows',
    skin => {
      const src = readFileSync(
        join(__dirname, `../../apps/web/src/templates/${skin}/Header.tsx`),
        'utf8'
      );
      expect(src).toMatch(/useTabBarShown\(\)/);
      expect(src).toMatch(/HEADER_MENU_WITH_TAB_BAR/);
    }
  );

  it('the BottomTabBar uses the same rule', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/web/src/templates/shared/BottomTabBar.tsx'),
      'utf8'
    );
    expect(src).toMatch(/useTabBarShown\(/);
    expect(HEADER_MENU_WITH_TAB_BAR).toMatch(/max-md:/);
  });
});
