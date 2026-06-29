import type { NavItem } from './buildStoreAdminNav';
import { HUBS, type HubLabels } from './hubs';

/**
 * A single searchable destination in the ⌘K command palette.
 * `group` is the hub/section it belongs to (e.g. "Catalog", "Settings") and is
 * shown as context + included in the fuzzy search so typing "stock" surfaces
 * every Inventory page even if the page's own name doesn't contain it.
 */
export interface PaletteItem {
  name: string;
  href: string;
  group?: string;
  icon?: string;
}

/** Labels for the Settings sub-pages (no hub tab bar, so not in hubs.ts). */
export interface SettingsPaletteLabels {
  branding: string;
  seo: string;
  domain: string;
  payments: string;
  shipping: string;
  tax: string;
  pwa: string;
  template: string;
  language: string;
  staff: string;
  announcement: string;
}

/**
 * Build the FULL searchable destination list for a store-admin context — not
 * just the ~8 sidebar hubs, but every page reachable inside them (hub tabs) plus
 * the Settings sub-pages. Respects role/feature gating implicitly: a hub's tabs
 * are only included when that hub survived the sidebar's `navItems` filter, so a
 * staff user (no Settings/Finance hub) never sees those pages in search.
 */
export function buildStorePaletteItems(
  navItems: NavItem[],
  storeId: string,
  hubLabels: HubLabels,
  settings: SettingsPaletteLabels
): PaletteItem[] {
  const items: PaletteItem[] = [];

  // 1. The visible hubs themselves (Dashboard, Catalog, Sales, …).
  for (const n of navItems) {
    items.push({ name: n.name, href: n.href, icon: n.icon, group: n.name });
  }

  // hubKey → display name, from the already-gated nav items.
  const hubNameByKey = new Map<string, string>();
  for (const n of navItems) if (n.hubKey) hubNameByKey.set(n.hubKey, n.name);

  // 2. Every tab inside each VISIBLE hub (skip hubs the user can't see).
  for (const hub of HUBS) {
    const group = hubNameByKey.get(hub.key);
    if (!group) continue;
    for (const tab of hub.buildTabs(storeId, hubLabels)) {
      items.push({ name: tab.label, href: tab.href, group });
    }
  }

  // 3. Settings sub-pages (cards, not tabs) — only when the Settings hub is
  //    visible (super_admin / store_admin, never staff).
  const settingsGroup = hubNameByKey.get('settings');
  if (settingsGroup) {
    const pages: Array<[string, string]> = [
      [settings.branding, `/stores/${storeId}/branding`],
      [settings.announcement, `/stores/${storeId}/announcement`],
      [settings.seo, `/stores/${storeId}/seo`],
      [settings.domain, `/stores/${storeId}/domain`],
      [settings.payments, `/stores/${storeId}/payment-settings`],
      [settings.shipping, `/stores/${storeId}/shipping`],
      [settings.tax, `/stores/${storeId}/tax`],
      [settings.pwa, `/stores/${storeId}/pwa`],
      [settings.template, `/stores/${storeId}/template`],
      [settings.language, `/stores/${storeId}/language`],
      [settings.staff, `/stores/${storeId}/staff`],
    ];
    for (const [name, href] of pages) items.push({ name, href, group: settingsGroup });
  }

  // Dedupe by href (a page could appear as both a hub landing + a tab).
  const seen = new Set<string>();
  return items.filter(i => (seen.has(i.href) ? false : (seen.add(i.href), true)));
}
