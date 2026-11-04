/**
 * Feature-keyed hub tabs (D1, customer wallet).
 *
 * The Sales hub's Wallet tab must not appear for a store without
 * `customer_wallet` — which is every store at launch. Other Sales tabs keep
 * the "tab always renders, the page gates" behaviour. The ⌘K palette must
 * apply the same gate, or the page would still be one search away.
 */
import { describe, it, expect } from 'vitest';
import { HUBS, type HubLabels } from '../hubs';
import { buildStorePaletteItems } from '../buildPaletteItems';
import type { NavItem } from '../buildStoreAdminNav';

const labels = new Proxy({} as HubLabels, { get: (_t, key) => String(key) });
// The wallet moved from Sales to the Marketing and offers hub with coupons, promotions, loyalty, bundles (UX:N-1).
const sales = HUBS.find(h => h.key === 'marketing')!;

describe('Marketing hub — Wallet tab', () => {
  it('carries the customer_wallet feature key; no other Marketing tab is feature-keyed', () => {
    const tabs = sales.buildTabs('s1', labels);
    const keyed = tabs.filter(t => t.featureKey);
    expect(keyed).toEqual([
      { label: 'wallet', href: '/stores/s1/wallet', featureKey: 'customer_wallet' },
    ]);
  });

  it('routes /wallet to the Marketing hub', () => {
    expect(sales.urlPrefixes).toContain('/wallet');
  });

  it('the command palette drops a feature-keyed tab the store cannot see', () => {
    const nav: NavItem[] = [
      { name: 'Marketing', href: '/stores/s1/coupons', icon: '', hubKey: 'marketing' },
    ];
    const settings = new Proxy({} as never, { get: (_t, k) => String(k) });
    const hidden = buildStorePaletteItems(nav, 's1', labels, settings, t => !t.featureKey);
    const shown = buildStorePaletteItems(nav, 's1', labels, settings, () => true);
    expect(hidden.some(i => i.href === '/stores/s1/wallet')).toBe(false);
    expect(shown.some(i => i.href === '/stores/s1/wallet')).toBe(true);
  });
});
