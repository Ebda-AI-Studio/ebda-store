/**
 * Every path that spends a paid model call (Gemini, Workers AI) is budgeted by `assertAiQuota` (#838, money-abuse audit
 * S25). `POST /stores/:id/ai/product-meta-aeo` and `POST /stores/:id/ai/product-faqs/draft` reached Gemini with no
 * quota check: the 150/day store slice and the platform caps were both bypassed, ~43k calls/day behind writeLimiter.
 *
 * Three checks, so the class cannot come back:
 *   1. behaviour: both routes, with the quota exhausted, answer 429 and never reach the model;
 *   2. static, per file, comments stripped: a file that calls a model has at least one `assertAiQuota(` per model call,
 *      or is on a short allowlist with its reason (an old version of this ratchet was satisfied by the WORD
 *      "assertAiQuota()" in a doc comment, which is how the FAQ generator slipped through);
 *   3. static, per caller: a module allowed to leave the budget to its callers is checked against those callers. Every
 *      file that CALLS one of its exported functions must itself call `assertAiQuota(` and must not be a route file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const h = vi.hoisted(() => ({ quotaCalls: [] as unknown[], modelCalls: 0 }));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (_q: unknown, _s: unknown, next: () => void) => next(),
  authorize: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/security', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/middleware/security')>()),
  writeLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/lib/store-ai-switch', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/store-ai-switch')>()),
  requireAiEnabled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/repo-factory')>()),
  storeDb: async () => ({
    product: {
      findFirst: async () => ({
        id: 'p1',
        name: 'Mug',
        nameAr: null,
        description: 'A mug',
        options: [],
      }),
    },
    store: { findUnique: async () => ({ name: 'Shop', nameAr: null }) },
  }),
}));
// The quota is exhausted: every assertAiQuota call is recorded and refused with the real code.
vi.mock('@api/lib/ai-quota', async importOriginal => {
  const real = await importOriginal<typeof import('@api/lib/ai-quota')>();
  const { AppError } = await import('@api/middleware/error-handler');
  return {
    ...real,
    assertAiQuota: async (opts: unknown) => {
      h.quotaCalls.push(opts);
      throw new AppError(429, real.AI_QUOTA_STORE_DAILY_CODE, 'cap reached');
    },
  };
});
vi.mock('@api/lib/ai/gemini-keys', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/ai/gemini-keys')>()),
  GeminiFailoverClient: class {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          h.modelCalls++;
          return { response: { text: () => '{}', usageMetadata: {} } };
        },
      };
    }
  },
}));

const STORE = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  h.quotaCalls = [];
  h.modelCalls = 0;
  process.env.GOOGLE_GENERATIVE_AI_KEY = 'test-key';
});

describe('1. the two per-product AI routes are budgeted', () => {
  const app = async () => {
    const { default: router } = await import('@api/routes/ai.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    const a = express();
    a.use(express.json());
    a.use('/stores/:storeId/ai', router, errorHandler);
    return a;
  };

  it.each([
    ['/product-meta-aeo', { productId: 'p1' }],
    ['/product-faqs/draft', { productId: 'p1', count: 3 }],
  ])(
    'POST %s at the cap: 429 AI_QUOTA_STORE_DAILY_EXCEEDED, the model is never called',
    async (path, body) => {
      const res = await request(await app())
        .post(`/stores/${STORE}/ai${path}`)
        .send(body);
      expect(res.status).toBe(429);
      expect(res.body?.error?.code).toBe('AI_QUOTA_STORE_DAILY_EXCEEDED');
      expect(h.quotaCalls).toEqual([{ storeId: STORE, bulk: false }]);
      expect(h.modelCalls).toBe(0);
    }
  );
});

// ── static checks ────────────────────────────────────────────────────────────

const SRC = join(__dirname, '..', '..', 'apps', 'api', 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
/** Source with block and line comments removed: a mention in a comment is not a call. */
export const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const files = walk(SRC);
const code = new Map(files.map(f => [f, stripComments(readFileSync(f, 'utf8'))]));
const rel = (p: string) => relative(SRC, p).split(sep).join('/');

/** A paid model call: Gemini SDK `generateContent(`, or a Workers AI binding `ai.run(` / `AI.run(`. */
export const MODEL_CALL = /\.generateContent\(|\bai\.run\(|\bAI\.run\(/g;
const QUOTA_CALL = /\bassertAiQuota\(/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** file -> why it may call a model without `assertAiQuota`. Keep this short and honest. */
const INFRA: Record<string, string> = {
  'lib/ai/gemini-keys.ts':
    'the failover client itself (it IS the model call every budgeted caller makes)',
  'lib/ai/eval/judge.ts': 'offline evaluation harness, never serves a merchant',
  'lib/search/embedding-provider.ts':
    'search embeddings (Workers AI bge-m3): platform search infrastructure, off unless SEARCH_SEMANTIC_ENABLED, not a merchant AI feature',
};
/** module -> why its callers own the budget. Check 3 proves each caller really does. */
const CALLERS_BUDGET: Record<string, string> = {
  'lib/ai/product-category-suggester.ts':
    'only bulk-ai-categorize calls it, which budgets per product',
  'lib/ai/product-excerpt-generator.ts': 'only bulk-ai-excerpt calls it, which budgets per product',
  'lib/ai/product-tag-suggester.ts': 'only bulk-ai-tags calls it, which budgets per product',
  'lib/ai/product-alt-text-generator.ts':
    'only bulk-ai-image-alt calls it, which budgets per product',
};

describe('2. every model call is budgeted (per file, comments stripped)', () => {
  it('finds the model callers at all (the scan is not vacuous)', () => {
    const callers = files.filter(f => count(code.get(f)!, MODEL_CALL) > 0);
    expect(callers.length).toBeGreaterThan(10);
  });

  it('no file calls a model more often than it calls assertAiQuota, outside the allowlists', () => {
    const offenders = files
      .filter(f => !(rel(f) in INFRA) && !(rel(f) in CALLERS_BUDGET))
      .map(f => ({
        f: rel(f),
        m: count(code.get(f)!, MODEL_CALL),
        q: count(code.get(f)!, QUOTA_CALL),
      }))
      .filter(x => x.m > 0 && x.q < x.m)
      .map(x => `${x.f}: ${x.m} model call(s), ${x.q} assertAiQuota`);
    expect(offenders).toEqual([]);
  });

  it('a comment that names assertAiQuota does not count as a call', () => {
    const src = stripComments(
      '/** assertAiQuota() runs upstream */\n// assertAiQuota()\nmodel.generateContent(p);'
    );
    expect(count(src, MODEL_CALL)).toBe(1);
    expect(count(src, QUOTA_CALL)).toBe(0);
  });

  it('the allowlists have no stale entries (each file exists and still calls a model)', () => {
    const byRel = new Map(files.map(f => [rel(f), f]));
    for (const f of [...Object.keys(INFRA), ...Object.keys(CALLERS_BUDGET)]) {
      expect(byRel.has(f), f).toBe(true);
      expect(count(code.get(byRel.get(f)!)!, MODEL_CALL), f).toBeGreaterThan(0);
    }
  });
});

describe('3. a module that leaves the budget to its callers: every caller budgets', () => {
  it('each caller of an exported function calls assertAiQuota and is not a route file', () => {
    const offenders: string[] = [];
    for (const mod of Object.keys(CALLERS_BUDGET)) {
      const modFile = files.find(f => rel(f) === mod)!;
      const exported = [...code.get(modFile)!.matchAll(/export async function (\w+)/g)].map(
        m => m[1]
      );
      expect(exported.length, mod).toBeGreaterThan(0);
      const base = mod.replace(/\.ts$/, '').split('/').pop()!;
      for (const f of files) {
        if (f === modFile) continue;
        const src = code.get(f)!;
        if (!new RegExp(`from '[^']*/${base}'`).test(src)) continue;
        const calls = exported.filter(fn => new RegExp(`\\b${fn}\\(`).test(src));
        if (calls.length === 0) continue; // imports a constant or a prompt builder only
        if (rel(f).startsWith('routes/'))
          offenders.push(
            `${rel(f)} calls ${calls.join(', ')} from a route (budget it in the module)`
          );
        else if (count(src, QUOTA_CALL) === 0)
          offenders.push(`${rel(f)} calls ${calls.join(', ')} with no assertAiQuota`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
