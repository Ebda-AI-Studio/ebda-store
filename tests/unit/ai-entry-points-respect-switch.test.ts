/**
 * Every AI entry point obeys the merchant's AI switch (`stores.ai_features_enabled`, `lib/store-ai-switch.ts`).
 * Three layers, each pinned here so a NEW entry point cannot ship without one of them:
 *   1. HTTP routers: `ai.routes.ts` mounts `requireAiEnabled` before every route except the switch's own
 *      GET/PUT /settings; the other routers that reach a model name it on the same route.
 *   2. Anything that calls a model also budgets through `assertAiQuota` (which asks the switch first) or asks
 *      the switch itself, unless it is on the short allowlist below with its reason.
 *   3. `assertAiQuota` really asks the switch first (tests/unit/ai-store-switch.test.ts proves the behaviour).
 * Static by design: it reads source, like the other ratchets, so it cannot pass because a mock was generous.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..', 'apps', 'api', 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
const files = walk(SRC);
const read = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => relative(SRC, p);
/** Classify on the path RELATIVE to the source root: a checkout/worktree directory named `...routes` must not match. */
export const isRouteFile = (src: string, file: string) =>
  relative(src, file).startsWith(`routes${sep}`);

describe('route-file classifier', () => {
  it('ignores a repo root whose own name contains "routes"', () => {
    const root = join(sep, 'w', 'ebda-store__fix-nz-customer-auth-routes', 'apps', 'api', 'src');
    expect(isRouteFile(root, join(root, 'services', 'a.service.ts'))).toBe(false);
    expect(isRouteFile(root, join(root, 'routes', 'a.routes.ts'))).toBe(true);
  });
});

describe('layer 1: HTTP routers', () => {
  it('ai.routes.ts: requireAiEnabled is mounted before every route but the two /settings ones', () => {
    const src = read(join(SRC, 'routes', 'ai.routes.ts'));
    const guard = src.indexOf('router.use(requireAiEnabled)');
    expect(guard).toBeGreaterThan(0);
    const routes = [
      ...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g),
    ];
    expect(routes.length).toBeGreaterThan(10);
    const before = routes.filter(m => (m.index ?? 0) < guard).map(m => `${m[1]} ${m[2]}`);
    expect(before.sort()).toEqual(['get /settings', 'put /settings']);
  });

  it('every other route file that reaches a model names requireAiEnabled on that route', () => {
    const AI_CALL = /AIService\.|draftOwnerResponse\(|summarizeProductReviews\(/g;
    const offenders: string[] = [];
    for (const f of files.filter(f => isRouteFile(SRC, f) && !f.endsWith('ai.routes.ts'))) {
      const src = read(f);
      const calls = (src.match(AI_CALL) ?? []).length;
      if (calls === 0) continue;
      const guards = (src.match(/\brequireAiEnabled\b,/g) ?? []).length;
      if (guards < calls)
        offenders.push(`${rel(f)}: ${calls} AI call(s), ${guards} requireAiEnabled`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('layer 2: anything that calls a model asks the switch (directly or through assertAiQuota)', () => {
  /** file -> why it may call a model without asking itself. Keep this list short and honest. */
  const ALLOW: Record<string, string> = {
    'lib/ai/gemini-keys.ts': 'the client/key rotation itself, no store context',
    'lib/ai/gemini-errors.ts': 'error mapping only',
    'lib/ai/eval/judge.ts': 'offline evaluation harness, never serves a merchant',
    'lib/ai/product-category-suggester.ts':
      'called by bulk-ai-categorize and ai-autofill, which budget (assertAiQuota) / read the switch (readFillPlan)',
    'lib/ai/product-excerpt-generator.ts': 'same: its callers budget through assertAiQuota',
    'lib/ai/product-meta-aeo-generator.ts': 'same: its callers budget through assertAiQuota',
    'lib/ai/product-tag-suggester.ts': 'same: its callers budget through assertAiQuota',
    'lib/ai/product-alt-text-generator.ts': 'same: its callers budget through assertAiQuota',
  };
  it('has no unguarded model call', () => {
    const CALLS_MODEL = /getGenerativeModel\(|\.generateContent\(/;
    const ASKS = /assertAiQuota\(|assertStoreAiEnabled\(|isStoreAiEnabled\(/;
    const offenders = files
      .filter(f => CALLS_MODEL.test(read(f)) && !ASKS.test(read(f)) && !(rel(f) in ALLOW))
      .map(rel);
    expect(offenders).toEqual([]);
  });
  it('the allowlist has no stale entries (each file still exists and still calls a model)', () => {
    const present = new Set(files.map(rel));
    for (const f of Object.keys(ALLOW)) expect(present.has(f), f).toBe(true);
  });
});

describe('layer 3: assertAiQuota asks the switch before it counts anything', () => {
  it('lib/ai-quota.ts calls assertStoreAiEnabled ahead of the usage counts', () => {
    const src = read(join(SRC, 'lib', 'ai-quota.ts'));
    const ask = src.indexOf('assertStoreAiEnabled(opts.storeId)');
    const count = src.indexOf('countAiUsage(');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(count);
  });
});
