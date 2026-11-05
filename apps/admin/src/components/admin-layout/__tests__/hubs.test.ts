/**
 * Hub map integrity (UX:N-1, N-2): every store page directory belongs to exactly one hub, and no URL prefix is
 * claimed by two hubs, so the sidebar and tab strip always highlight something and never two things.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HUBS, detectHub, type HubLabels } from '../hubs';

const PAGES = join(__dirname, '../../../app/stores/[id]');
const labels = new Proxy({} as HubLabels, { get: (_t, key) => String(key) });

/** Directories that are not merchant pages or are deliberately outside every hub. */
const OUTSIDE_HUBS = new Set([
  'features', // super-admin only (own nav item)
  'hero', // retired route, redirects
  'inventory', // retired route, redirects to /stock/inventory
  'navigation', // redirects into the editor
  'pages', // redirects to /content
]);

const pageDirs = readdirSync(PAGES).filter(
  n => statSync(join(PAGES, n)).isDirectory() && !n.startsWith('_')
);

describe('hubs', () => {
  it('no URL prefix is claimed by two hubs', () => {
    const seen = new Map<string, string>();
    for (const hub of HUBS) {
      for (const p of hub.urlPrefixes) {
        if (p === '') continue;
        expect(seen.get(p), `${p} is in both ${seen.get(p)} and ${hub.key}`).toBeUndefined();
        seen.set(p, hub.key);
      }
    }
  });

  it.each(pageDirs.filter(d => !OUTSIDE_HUBS.has(d)))('/%s belongs to a hub', dir => {
    const hub = detectHub(`/stores/s1/${dir}`, 's1');
    expect(hub, `${dir} matches no hub`).not.toBeNull();
  });

  it('moved pages land in their new hubs', () => {
    const key = (p: string) => detectHub(`/stores/s1/${p}`, 's1')?.key;
    for (const p of ['coupons', 'promotions', 'loyalty', 'bundles', 'wallet'])
      expect(key(p)).toBe('marketing');
    for (const p of ['orders', 'invoices', 'returns', 'customers', 'reviews'])
      expect(key(p)).toBe('sales');
    expect(key('notifications')).toBe('marketing'); // staff-accessible, so not in the owner-only Settings hub
    for (const p of ['categories', 'tags', 'bulk']) expect(key(p)).toBe('catalog');
    for (const p of ['delivery', 'staff']) expect(key(p)).toBe('settings');
  });

  it('every hub tab href sits inside the hub that lists it', () => {
    for (const hub of HUBS) {
      for (const tab of hub.buildTabs('s1', labels)) {
        expect(detectHub(tab.href, 's1')?.key, tab.href).toBe(hub.key);
      }
    }
  });

  it('Sales and Marketing strips are divided into groups', () => {
    for (const k of ['sales', 'marketing']) {
      const tabs = HUBS.find(h => h.key === k)!.buildTabs('s1', labels);
      expect(
        tabs.some(t => t.groupStart),
        `${k} has no divider`
      ).toBe(true);
    }
  });
});
