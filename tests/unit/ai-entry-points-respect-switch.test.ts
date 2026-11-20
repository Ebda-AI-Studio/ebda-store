/**
 * Every AI entry point obeys the merchant's AI switch (`stores.ai_features_enabled`, `lib/store-ai-switch.ts`).
 * Three layers, each pinned here so a NEW entry point cannot ship without one of them:
 *   1. HTTP routers: `ai.routes.ts` mounts `requireAiEnabled` before every route except the switch's own
 *      GET/PUT /settings; the other routers that reach a model name it on the same route.
 *   2. Anything that calls a model also budgets through `assertAiQuota` (which asks the switch first) or asks
 *      the switch itself, unless it is on the short allowlist below with its reason.
 *   3. `assertAiQuota` really asks the switch first (tests/unit/ai-store-switch.test.ts proves the behaviour).
 * Layers 2 and 3 are static by design (they read source, like the other ratchets, so they cannot pass because a mock was
 * generous); layer 1 runs the real router, because route order is control flow, not text.
 */
import { describe, it, expect, vi } from 'vitest';
import express, { type RequestHandler, type Router } from 'express';
import request from 'supertest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// The real ai.routes.ts router is mounted for the layer-1 behaviour test. The auth chain is stubbed to pass through (it is
// not what is under test); the merchant's switch is read through a fake store backend that this file flips.
const sw = vi.hoisted(() => ({ enabled: false }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (_q: unknown, _s: unknown, next: () => void) => next(),
  authorize: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_storeId: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/repo-factory')>()),
  storeDb: async () => ({
    store: { findUnique: async () => ({ aiFeaturesEnabled: sw.enabled, status: 'active' }) },
  }),
}));

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
  it('ai.routes.ts: with the switch off, every route but the two /settings ones is refused 403 AI_DISABLED_BY_MERCHANT', async () => {
    // Behaviour, not text order: mount the REAL router and send each registered route a request while the merchant's
    // AI switch is off. A guard registered after a route, in another branch, or dead leaves that route answering.
    sw.enabled = false;
    const { default: router } = await import('@api/routes/ai.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    const app = express();
    app.use(express.json());
    app.use('/stores/:storeId/ai', router, errorHandler);
    const STORE = '11111111-1111-4111-8111-111111111111';

    const registered = (router as unknown as Router).stack.flatMap(l =>
      l.route
        ? Object.keys((l.route as unknown as { methods: Record<string, boolean> }).methods).map(
            method => ({ method, path: l.route!.path as string })
          )
        : []
    );
    expect(registered.length).toBeGreaterThan(10);

    const refused: string[] = [];
    const answered: string[] = [];
    for (const { method, path } of registered) {
      const url = `/stores/${STORE}/ai${path.replace(/:\w+\??/g, '22222222-2222-4222-8222-222222222222')}`;
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)
        [method](url)
        .send({});
      const label = `${method} ${path}`;
      if (res.status === 403 && res.body?.error?.code === 'AI_DISABLED_BY_MERCHANT')
        refused.push(label);
      else answered.push(label);
    }
    // Only the switch's own read and write may be reached while it is off.
    expect(answered.sort()).toEqual(['get /settings', 'put /settings']);
    expect(refused.length).toBe(registered.length - 2);
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

// layer 3 (assertAiQuota asks the switch before it counts anything) is a behaviour test now:
// tests/unit/ai-quota-switch-first.test.ts runs the real assertAiQuota with the switch off and asserts no count ran.
