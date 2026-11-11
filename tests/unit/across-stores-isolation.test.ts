/**
 * Issue #619: `acrossStores` aborted the whole sweep on one store's error and always visited stores in the same order,
 * so every store after a failing one was starved every tick (abandoned-cart, payments-reconcile, PII retention).
 * Default = isolate + rotate + one summary line. All-or-nothing is an EXPLICIT `abortOnError: true`, and this test
 * lists every caller allowed to use it so a cron cannot opt back in unnoticed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { acrossStores, setScopeResolver } from '../../packages/database/src/index';

// lazy scope: no Postgres needed; the runner only validates the UUID and scopes the callback
setScopeResolver({ lazyForStore: async () => true, lazyForUser: () => true });
const U = (c: string) => `00000000-0000-4000-8000-00000000000${c}`;
const [a, b, c, d, e] = ['1', '2', '3', '4', '5'].map(U);
const ids = [a, b, c, d, e];

describe('acrossStores default isolation', () => {
  it('a failing store does not stop the stores after it; failures are reported', async () => {
    const seen: string[] = [];
    const res = await acrossStores(
      async id => {
        if (id === b) throw new Error('boom');
        seen.push(id);
        return id;
      },
      { storeIds: ids, startOffset: 0, concurrency: 1 }
    );
    expect(seen).toEqual([a, c, d, e]);
    expect(res.map(r => r.storeId)).toEqual([a, c, d, e]);
    expect(res.failures.map(f => f.storeId)).toEqual([b]);
  });
  it('rotates the start so a store is not always last', async () => {
    const order = async (off: number) => {
      const seen: string[] = [];
      await acrossStores(async id => void seen.push(id), {
        storeIds: ids,
        startOffset: off,
        concurrency: 1,
      });
      return seen;
    };
    expect((await order(0))[0]).toBe(a);
    expect((await order(2))[0]).toBe(c);
    expect(await order(7)).toEqual([c, d, e, a, b]);
  });
  it('logs ONE summary line with counts, not one per store', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await acrossStores(
      async () => {
        throw new Error('x');
      },
      { storeIds: ids, startOffset: 0 }
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('"failed":5');
    spy.mockRestore();
  });
  it('abortOnError: true rejects on the first error (explicit opt-in)', async () => {
    await expect(
      acrossStores(
        async id => {
          if (id === b) throw new Error('boom');
        },
        { storeIds: ids, startOffset: 0, concurrency: 1, abortOnError: true }
      )
    ).rejects.toThrow('boom');
  });
});

describe('guard: only completeness-critical callers may set abortOnError', () => {
  const ALLOWED = new Set([
    'lib/cross-store.ts', // user/admin cross-store reads: a partial list would be a wrong answer
    'routes/admin.routes.ts',
    'services/store.service.ts',
    'services/provisioning.service.ts',
    'services/provider-activation.service.ts',
    'services/billing/account.service.ts',
  ]);
  it('no cron / job / other service opts back into abort-all', () => {
    const root = join(__dirname, '../../apps/api/src');
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.ts') && !f.endsWith('.test.ts')) {
          const rel = f.slice(root.length + 1);
          if (/abortOnError/.test(readFileSync(f, 'utf8')) && !ALLOWED.has(rel)) bad.push(rel);
        }
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });
});
