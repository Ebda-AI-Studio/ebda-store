'use client';

/**
 * IA-10: one mobile menu. The BottomTabBar (below md) carries the "Menu" tab, so a
 * header hamburger on the same screen opened the same navigation twice. Both read
 * this one rule: the tab bar shows everywhere except mid-purchase routes (checkout,
 * auth, order detail), where the header keeps its menu button.
 */
import { usePathname } from 'next/navigation';

const TAB_BAR_HIDDEN_ON = ['/checkout', '/auth/', '/account/order'];

/** The pathname includes the store slug prefix on path-based tenants, so match segments. */
export function tabBarShownOn(pathname: string): boolean {
  const lowered = pathname.toLowerCase();
  return !TAB_BAR_HIDDEN_ON.some(p => lowered.includes(p));
}

export function useTabBarShown(): boolean {
  return tabBarShownOn(usePathname() ?? '/');
}

/** Header menu button while the tab bar shows: gone below md (the tab bar's Menu replaces it). */
export const HEADER_MENU_WITH_TAB_BAR = 'max-md:hidden';
/**
 * Same, for a skin whose hamburger holds the inline-start slot of a justify-between row:
 * invisible (out of the accessibility tree) so the end icons do not slide to the start.
 */
export const HEADER_MENU_WITH_TAB_BAR_KEEP_SLOT = 'max-md:invisible';
