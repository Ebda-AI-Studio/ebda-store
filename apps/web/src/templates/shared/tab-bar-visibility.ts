'use client';

/**
 * IA-10: one mobile menu. The BottomTabBar (below md) carries the "Menu" tab, so a
 * header hamburger on the same screen opened the same navigation twice. Both read
 * this one rule: the tab bar shows everywhere except mid-purchase routes (checkout,
 * auth, order detail), where the header keeps its menu button.
 */
import { usePathname } from 'next/navigation';
import { resolveTabBar, type TabBarMode } from '@ebda/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';

const TAB_BAR_HIDDEN_ON = ['/checkout', '/auth/', '/account/order'];

/** The pathname includes the store slug prefix on path-based tenants, so match segments. */
export function tabBarShownOn(pathname: string, mode: TabBarMode = 'always', prefix = ''): boolean {
  if (mode === 'never') return false;
  const lowered = pathname.toLowerCase();
  if (TAB_BAR_HIDDEN_ON.some(p => lowered.includes(p))) return false;
  if (mode === 'inner' && isHomePath(lowered, prefix)) return false;
  return true;
}

/** The store home: `/`, a locale root (`/ar`), or the slug root, with or without a trailing slash. */
export function isHomePath(lowered: string, prefix = ''): boolean {
  let path = lowered;
  const p = prefix.toLowerCase().replace(/\/$/, '');
  if (p && path.startsWith(p)) path = path.slice(p.length);
  path = path.replace(/\/+$/, '') || '/';
  return path === '/' || path === '/ar' || path === '/en';
}

/**
 * Whether the phone tab bar shows here: the merchant's `theme.tabBar`, else the look's default (no bar on the
 * home page, the header bag is the cart), else the old always-on bar for a store with no look.
 */
export function useTabBarShown(): boolean {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const mode = resolveTabBar(store?.theme, store?.look);
  return tabBarShownOn(usePathname() ?? '/', mode, storeUrl(''));
}

/** Header menu button while the tab bar shows: gone below md (the tab bar's Menu replaces it). */
export const HEADER_MENU_WITH_TAB_BAR = 'max-md:hidden';
/**
 * Same, for a skin whose hamburger holds the inline-start slot of a justify-between row:
 * invisible (out of the accessibility tree) so the end icons do not slide to the start.
 */
export const HEADER_MENU_WITH_TAB_BAR_KEEP_SLOT = 'max-md:invisible';
