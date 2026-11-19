import { describe, expect, it } from 'vitest';
import { readConfig } from '../helpers/capability-facts';
import { idsOf, judge, loadBaseline, loadRegistry } from '../helpers/capability-guard';
import { checkRegistry } from '../../packages/shared/src/foundation/capability-registry';

describe('capability registry rules (lens 192)', () => {
  const { entries, violations } = loadRegistry();

  it('loads every seeded capability', () => {
    expect(entries.length).toBeGreaterThanOrEqual(185);
  });

  it('has no new registry violation and no stale baseline id (shrink-only debt)', () => {
    const r = judge('registry', violations);
    expect(r.failures).toEqual([]);
  });

  it('the registry baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(violations));
    expect(loadBaseline('registry').filter(id => !current.has(id))).toEqual([]);
  });

  it('a deliberately broken entry fails (mutation proof: the guard can fail)', () => {
    const broken = { ...(entries[0] as object), policy: 'free', api: ['POST /stores/:storeId/x'] };
    const r = checkRegistry(
      [{ name: `${entries[0]!.id}.capability.json`, json: broken }],
      readConfig()
    );
    expect(r.violations.map(v => v.rule)).toContain('policy-free-writes');
  });
});
