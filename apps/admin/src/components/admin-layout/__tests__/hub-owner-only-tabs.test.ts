/**
 * Setup emails tab is the owner's: hidden from staff in the hub strip AND in the ⌘K palette (and the admin
 * search registry), visible to the store owner and super_admin. The API route 403s staff too
 * (tests/unit/lifecycle-emails-routes.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { HUBS, isHubTabVisible, type HubLabels } from '../hubs';
import { buildStorePaletteItems } from '../buildPaletteItems';
import type { NavItem } from '../buildStoreAdminNav';
import { canSeeEntry } from '../../../lib/settings-search';
import { PAGES } from '../../../lib/settings-registry';

const labels = new Proxy({} as HubLabels, { get: (_t, key) => String(key) });
const marketing = HUBS.find(h => h.key === 'marketing')!;
const tab = marketing.buildTabs('s1', labels).find(t => t.href === '/stores/s1/lifecycle-emails')!;
const ctx = (role: string) => ({ role, featuresLoading: false, isEnabled: () => true });

describe('Setup emails tab is owner-only', () => {
  it('is flagged ownerOnly and is the only owner-only Marketing tab', () => {
    expect(tab.ownerOnly).toBe(true);
    expect(marketing.buildTabs('s1', labels).filter(t => t.ownerOnly)).toHaveLength(1);
  });

  it('is hidden from staff, shown to store_admin and super_admin', () => {
    expect(isHubTabVisible(tab, ctx('staff'))).toBe(false);
    expect(isHubTabVisible(tab, ctx('store_admin'))).toBe(true);
    expect(isHubTabVisible(tab, ctx('super_admin'))).toBe(true);
  });

  it('the palette drops it for staff', () => {
    const nav: NavItem[] = [
      { name: 'Marketing', href: '/stores/s1/coupons', icon: '', hubKey: 'marketing' },
    ];
    const settings = new Proxy({} as never, { get: (_t, k) => String(k) });
    const forStaff = buildStorePaletteItems(nav, 's1', labels, settings, t =>
      isHubTabVisible(t, ctx('staff'))
    );
    const forOwner = buildStorePaletteItems(nav, 's1', labels, settings, t =>
      isHubTabVisible(t, ctx('store_admin'))
    );
    expect(forStaff.some(i => i.href === '/stores/s1/lifecycle-emails')).toBe(false);
    expect(forOwner.some(i => i.href === '/stores/s1/lifecycle-emails')).toBe(true);
  });

  it('the admin search registry hides it from staff too', () => {
    const entry = PAGES.find(p => p.route === '/lifecycle-emails')!;
    const idx = { ...entry } as never;
    const c = (role: string) => ({ role, isFeatureEnabled: () => true, featuresLoading: false });
    expect(canSeeEntry(idx, c('staff'))).toBe(false);
    expect(canSeeEntry(idx, c('store_admin'))).toBe(true);
    expect(canSeeEntry(idx, c('super_admin'))).toBe(true);
  });
});
