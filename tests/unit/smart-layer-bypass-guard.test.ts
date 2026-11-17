import { describe, expect, it } from 'vitest';
import { checkModelBypass } from '../../packages/shared/src/foundation/smart-layer-bypass';
import { readConfig } from '../helpers/capability-facts';
import { bypassFiles, idsOf, judge, loadBaseline } from '../helpers/capability-guard';

const cfg = readConfig();

describe('Smart Layer bypass: no direct model call outside the Smart Layer', () => {
  const files = bypassFiles();

  it('scans the real tree (positive control)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some(f => f.path.endsWith('wrangler.jsonc'))).toBe(true);
  });

  it('has no new direct model call and no stale baseline id', () => {
    expect(judge('bypass', checkModelBypass(files, cfg)).failures).toEqual([]);
  });

  it('the bypass baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkModelBypass(files, cfg)));
    expect(loadBaseline('bypass').filter(id => !current.has(id))).toEqual([]);
  });

  it('a deliberately added model call fails (mutation proof)', () => {
    const extra = {
      path: 'apps/api/src/zz-invented.ts',
      src: 'const r = await env.AI.run(model, input);',
    };
    expect(
      checkModelBypass([...files, extra], cfg).some(v =>
        v.key.startsWith('apps/api/src/zz-invented.ts')
      )
    ).toBe(true);
  });
});
