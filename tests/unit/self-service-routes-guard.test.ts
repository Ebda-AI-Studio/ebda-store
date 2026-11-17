import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeFacts } from '../../packages/shared/src/foundation/capability-coverage';
import { checkSelfServiceRoutes } from '../../packages/shared/src/foundation/self-service-routes';
import { readConfig, storeCodeFacts } from '../helpers/capability-facts';
import { idsOf, judge, loadBaseline, loadRegistry } from '../helpers/capability-guard';

let facts: CodeFacts;
const { entries } = loadRegistry();
beforeAll(async () => {
  facts = await storeCodeFacts(readConfig());
}, 120_000);

describe('self-service routes: super-admin routes carry a valid operator reason', () => {
  it('has no new unreasoned super-admin route or invalid reason and no stale baseline id', () => {
    expect(judge('superadmin', checkSelfServiceRoutes(facts, entries)).failures).toEqual([]);
  });

  it('the superadmin baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkSelfServiceRoutes(facts, entries)));
    expect(loadBaseline('superadmin').filter(id => !current.has(id))).toEqual([]);
  });

  it('a deliberately unreasoned super-admin route fails (mutation proof)', () => {
    const v = checkSelfServiceRoutes(
      {
        ...facts,
        routes: [
          ...facts.routes,
          { method: 'POST', path: '/admin/zz-invented', kind: 'super_admin' },
        ],
      },
      entries
    );
    expect(idsOf(v)).toContain('superadmin-route-unreasoned|POST /admin/zz-invented');
  });
});
