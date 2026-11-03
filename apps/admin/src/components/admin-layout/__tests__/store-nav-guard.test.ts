/**
 * P0 logout audit (2026-11-03): AdminLayout built store nav before the store id resolved, so the router prefetched
 * `/stores//finance/dashboard` (normalised to `/stores/finance/dashboard`, a 404). No nav href may be built without an id.
 */
import { describe, it, expect } from 'vitest';
import { buildStoreAdminNav } from '../buildStoreAdminNav';
import { HUBS, type HubLabels } from '../hubs';

const navLabels = new Proxy({} as Parameters<typeof buildStoreAdminNav>[1], {
  get: (_t, key) => String(key),
});
const hubLabels = new Proxy({} as HubLabels, { get: (_t, key) => String(key) });

describe('store nav is never built without a store id', () => {
  it.each([[''], [null], [undefined]])('returns no links for id %j', id => {
    expect(buildStoreAdminNav(id as unknown as string, navLabels)).toEqual([]);
  });

  it('with an id, every store href is under /stores/<id> and none has an empty segment', () => {
    const items = buildStoreAdminNav('s1', navLabels);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.href).not.toContain('/stores//');
      expect(i.href.startsWith('/stores/s1')).toBe(true);
    }
  });

  it('hub tabs never contain an empty store segment', () => {
    for (const h of HUBS) {
      for (const t of h.buildTabs('s1', hubLabels)) {
        expect(t.href).not.toContain('/stores//');
        expect(t.href.startsWith('/stores/s1')).toBe(true);
      }
    }
  });
});
