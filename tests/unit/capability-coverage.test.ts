import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkCoverage,
  type CodeFacts,
} from '../../packages/shared/src/foundation/capability-coverage';
import { readConfig, storeCodeFacts } from '../helpers/capability-facts';
import { idsOf, judge, loadBaseline, loadRegistry } from '../helpers/capability-guard';

let facts: CodeFacts;
const { entries } = loadRegistry();
beforeAll(async () => {
  facts = await storeCodeFacts(readConfig());
}, 120_000);

describe('capability coverage: every page, route, MCP tool and plan gate belongs to a capability', () => {
  it('has no new uncovered page, route, tool or gate and no stale baseline id', () => {
    const r = judge('coverage', checkCoverage(facts, entries));
    expect(r.failures).toEqual([]);
  });

  it('the coverage baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkCoverage(facts, entries)));
    expect(loadBaseline('coverage').filter(id => !current.has(id))).toEqual([]);
  });

  it('a deliberately unregistered fake page fails coverage (mutation proof)', () => {
    const v = checkCoverage(
      { ...facts, pages: [...facts.pages, '/stores/[id]/zz-invented-feature'] },
      entries
    );
    expect(v.map(x => `${x.rule}|${x.key}`)).toContain(
      'page-uncovered|/stores/[id]/zz-invented-feature'
    );
  });

  it('a deliberately unregistered fake merchant route fails coverage (mutation proof)', () => {
    const v = checkCoverage(
      {
        ...facts,
        routes: [
          ...facts.routes,
          { method: 'POST', path: '/stores/:storeId/zz-invented', kind: 'merchant' },
        ],
      },
      entries
    );
    expect(v.map(x => `${x.rule}|${x.key}`)).toContain(
      'route-uncovered|POST /stores/:storeId/zz-invented'
    );
  });

  it('dropping a discovered route from the facts surfaces the dangling live entry (adapter mutation proof)', () => {
    const target = 'PUT /stores/:storeId/orders/:id/status';
    const without = {
      ...facts,
      routes: facts.routes.filter(r => `${r.method} ${r.path}` !== target),
    };
    expect(
      checkCoverage(facts, entries).some(v => v.rule === 'route-dangling' && v.key.includes(target))
    ).toBe(false);
    expect(
      checkCoverage(without, entries).some(
        v => v.rule === 'route-dangling' && v.key.includes(target)
      )
    ).toBe(true);
  });
});
