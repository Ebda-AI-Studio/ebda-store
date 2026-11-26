/**
 * #845 (Ruling AI-SLICE-ATOMIC-1): the per-store daily AI slice is reserved atomically BEFORE the model call, so 20
 * parallel calls at cap-1 yield exactly one success. The old check-then-act counted `ai_usage` rows (written after the
 * call) and let all 20 through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const counters = new Map<string, number>();
  return {
    counters,
    rows: 0,
    // a real await between increment and read, so interleaving is genuine
    tick: () => new Promise<void>(r => setTimeout(r, 1)),
  };
});

vi.mock('@api/lib/store-ai-switch', () => ({
  AI_DISABLED_BY_MERCHANT_CODE: 'AI_DISABLED_BY_MERCHANT',
  assertStoreAiEnabled: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/ai-plan-gate', () => ({
  assertStoreAiPlan: async () => undefined,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    incrementRateLimit: async (k: string) => {
      const n = (h.counters.get(k) ?? 0) + 1;
      h.counters.set(k, n);
      await h.tick();
      return n;
    },
    getRateLimitCount: async (k: string) => h.counters.get(k) ?? 0,
    decrementRateLimit: async (k: string) => {
      const n = (h.counters.get(k) ?? 0) - 1;
      if (n <= 0) h.counters.delete(k);
      else h.counters.set(k, n);
    },
  },
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    aiUsage: {
      count: async () => {
        await h.tick();
        return h.rows;
      },
    },
  },
}));
vi.mock('../../apps/api/src/lib/definer', () => ({ countAiUsage: async () => 0 }));

import { assertAiQuota } from '../../apps/api/src/lib/ai-quota';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const CAP = 150;
const settle = (n: number) =>
  Promise.allSettled(Array.from({ length: n }, () => assertAiQuota({ storeId: 's1' })));
const ok = (r: PromiseSettledResult<unknown>[]) => r.filter(x => x.status === 'fulfilled').length;

beforeEach(() => {
  h.counters.clear();
  h.rows = 0;
  process.env.AI_STORE_DAILY_REQUEST_CAP = String(CAP);
  process.env.AI_DAILY_REQUEST_CAP = '100000';
});

describe('per-store daily slice is atomic', () => {
  it('20 parallel calls at cap-1 -> exactly 1 succeeds, the rest get the store-cap 429', async () => {
    h.rows = CAP - 1;
    const r = await settle(20);
    expect(ok(r)).toBe(1);
    for (const x of r) {
      if (x.status === 'rejected')
        expect(x.reason).toMatchObject({ statusCode: 429, code: 'AI_QUOTA_STORE_DAILY_EXCEEDED' });
    }
  });

  it('far below the cap, parallel calls all pass (no false refusals)', async () => {
    h.rows = 10;
    expect(ok(await settle(20))).toBe(20);
  });

  it('a refused call gives its slot back: at the cap everything is refused, then cap-1 admits one', async () => {
    h.rows = CAP;
    expect(ok(await settle(5))).toBe(0);
    h.rows = CAP - 1;
    expect(ok(await settle(5))).toBe(1);
  });

  it('the handle releases exactly its own slot, once (idempotent), and frees room', async () => {
    h.rows = CAP - 2;
    const held = await Promise.all([
      assertAiQuota({ storeId: 's1' }),
      assertAiQuota({ storeId: 's1' }),
    ]);
    expect(ok(await settle(3))).toBe(0); // both slots held
    await held[0].release();
    await held[0].release(); // a second release frees nothing more
    expect(ok(await settle(1))).toBe(1);
  });

  it('a check-only probe (reserve: false) counts but holds nothing', async () => {
    h.rows = CAP - 1;
    for (let i = 0; i < 5; i++) await assertAiQuota({ storeId: 's1', reserve: false });
    expect([...h.counters.values()].reduce((a, n) => a + n, 0)).toBe(0);
    expect(ok(await settle(3))).toBe(1);
  });
});

describe('every reserving call site releases its slot (static ratchet, comments stripped)', () => {
  const SRC = join(__dirname, '..', '..', 'apps', 'api', 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
      return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
    });
  const strip = (x: string) =>
    x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

  it('a reserving assertAiQuota is held in a variable and released in a finally; anything else is reserve: false', () => {
    const offenders: string[] = [];
    let reserving = 0;
    for (const f of walk(SRC)) {
      if (f.endsWith(join('lib', 'ai-quota.ts'))) continue;
      const src = strip(readFileSync(f, 'utf8'));
      const calls = [...src.matchAll(/(=\s*)?await assertAiQuota\(([^)]*)\)/g)];
      for (const c of calls) {
        if (/reserve:\s*false/.test(c[2])) continue;
        reserving++;
        if (!c[1])
          offenders.push(`${relative(SRC, f)}: assertAiQuota result dropped (slot never released)`);
      }
      const held = calls.filter(c => c[1] && !/reserve:\s*false/.test(c[2])).length;
      const released = (src.match(/finally\s*\{\s*await \w+\??\.release\(\)/g) ?? []).length;
      if (released < held)
        offenders.push(
          `${relative(SRC, f)}: ${held} held slot(s), ${released} released in a finally`
        );
    }
    expect(reserving).toBeGreaterThan(20); // the scan is not vacuous
    expect(offenders).toEqual([]);
  });

  it('reserve: false only where NO model call follows (probes); a model call is never reachable behind a check-only quota', () => {
    /** file -> why it may check without reserving. A file here must not call a model or a model-calling generator. */
    const CHECK_ONLY: Record<string, string> = {
      'lib/inngest/functions/queue-depth-watch.ts':
        'resume probe: decides whether to re-send a stuck sweep, no model call',
    };
    const MODEL = /\.generateContent\(|\bai\.run\(|\bAI\.run\(|\bgenerateProduct\w+\(/;
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const src = strip(readFileSync(f, 'utf8'));
      if (!/assertAiQuota\([^)]*reserve:\s*false/.test(src)) continue;
      const rel = relative(SRC, f).split('\\').join('/');
      if (!(rel in CHECK_ONLY))
        offenders.push(`${rel}: reserve: false outside the probe allowlist`);
      else if (MODEL.test(src)) offenders.push(`${rel}: a check-only file reaches a model call`);
    }
    expect(offenders).toEqual([]);
  });
});
