import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeFacts } from '../../packages/shared/src/foundation/capability-coverage';
import { readConfig, storeCodeFacts, toFactRoutes, walkRoutes } from '../helpers/capability-facts';

let facts: CodeFacts;
beforeAll(async () => {
  facts = await storeCodeFacts(readConfig());
}, 120_000);

describe('store code facts come from the real code', () => {
  it('globs the admin pages (dynamic segments kept)', () => {
    expect(facts.pages).toContain('/stores/[id]');
    expect(facts.pages.length).toBeGreaterThanOrEqual(150);
  });

  it('walks the router table: merchant orders route, no HEAD/OPTIONS', () => {
    expect(facts.routes).toContainEqual({
      method: 'PUT',
      path: '/stores/:storeId/orders/:id/status',
      kind: 'merchant',
    });
    expect(facts.routes.some(r => r.method === 'HEAD' || r.method === 'OPTIONS')).toBe(false);
  });

  it('recovers every mount prefix cleanly (no regexp residue)', () => {
    expect(facts.routes.filter(r => /\(\?|\\/.test(r.path))).toEqual([]);
  });

  it('tags super_admin-only routes from authorize() (platform-tax)', () => {
    const sa = facts.routes.filter(r => r.kind === 'super_admin');
    expect(sa.length).toBeGreaterThan(5);
    expect(sa.some(r => r.path.includes('/admin/'))).toBe(true);
  });

  it('classifies /public as public via guard.config routeKinds', () => {
    const pub = facts.routes.filter(r => r.path.startsWith('/public/'));
    expect(pub.length).toBeGreaterThan(10);
    expect(pub.every(r => r.kind === 'public')).toBe(true);
  });

  it('lists the merchant MCP tools and plan gates', () => {
    expect(facts.mcpTools).toEqual(
      expect.arrayContaining(['admin_list_orders', 'admin_update_order_status'])
    );
    expect(facts.planGates!.length).toBeGreaterThan(10);
  });

  it('ALL expands to the verbs in use', () => {
    const cfg = readConfig();
    const rs = toFactRoutes(
      [
        { method: 'ALL', path: '/x', roleLists: [] },
        { method: 'HEAD', path: '/x', roleLists: [] },
      ],
      cfg
    );
    expect(rs.map(r => r.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect(walkRoutes([])).toEqual([]);
  });
});
