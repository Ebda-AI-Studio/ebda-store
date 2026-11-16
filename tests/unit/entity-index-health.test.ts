/**
 * Issue 458 (Ruling NZ-MONEY-5): a StoreDO records its dead-lettered entity-index rows in D1 `system_settings`; the API Worker's
 * hourly cron alerts ONE aggregated P1 per run. A fake D1 over a key/value map stands in for the two `system_settings` families.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/cf/bindings', () => ({ cfBindings: () => undefined }));

import { alertEntityIndexHealth, ALERTED_PREFIX } from '../../apps/api/src/lib/entity-index-health';
import {
  INDEX_HEALTH_PREFIX,
  indexHealthKey,
  publishIndexHealth,
  type DeadLetterReport,
} from '../../apps/api/src/cf/store-do/index-health';

function fakeD1() {
  const kv = new Map<string, string>();
  const deletedStores = new Set<string>();
  const maxParams: number[] = [];
  const calls: string[] = [];
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...v: unknown[]) => ({
        all: async () => {
          if (sql.includes('FROM stores')) {
            maxParams.push(v.length);
            if (v.length > 100) throw new Error('too many SQL variables');
            return { results: v.filter(id => deletedStores.has(String(id))).map(id => ({ id })) };
          }
          return {
            results: [...kv]
              .filter(
                ([k]) =>
                  k.startsWith(String(v[0]).replace('%', '')) ||
                  k.startsWith(String(v[1]).replace('%', ''))
              )
              .map(([key, value]) => ({ key, value })),
          };
        },
        run: async () => {
          calls.push(sql.split(' ')[0]!);
          if (sql.startsWith('DELETE')) kv.delete(String(v[0]));
          else if (sql.startsWith('INSERT')) {
            const value = String(v[2]);
            kv.set(String(v[1]), value);
          }
        },
      }),
    }),
  };
  return { kv, d1, calls, deletedStores, maxParams };
}
const report = (n: number, abandoned = false): DeadLetterReport => ({
  dead: n,
  abandoned: abandoned ? n : 0,
  rows: Array.from({ length: n }, (_, i) => ({
    outboxId: i + 1,
    kind: 'payment',
    id: `pay-${i + 1}`,
    storeId: 's1',
    attempts: abandoned ? 999 : 20,
    abandoned,
  })),
});

describe('StoreDO publishes entity-index health', () => {
  it('writes a row while rows are dead, skips an unchanged set, deletes it when cleared', async () => {
    const f = fakeD1();
    const sig1 = await publishIndexHealth(f.d1, 's1', report(2), null, 1000);
    expect(sig1).not.toBeNull();
    expect(JSON.parse(f.kv.get(indexHealthKey('s1'))!)).toMatchObject({ storeId: 's1', dead: 2 });
    const before = f.calls.length;
    expect(await publishIndexHealth(f.d1, 's1', report(2), sig1, 2000)).toBe(sig1);
    expect(f.calls.length).toBe(before); // unchanged: no D1 call
    expect(await publishIndexHealth(f.d1, 's1', report(0), sig1, 3000)).toBeNull();
    expect(f.kv.has(indexHealthKey('s1'))).toBe(false);
    // nothing published and nothing dead: no D1 call at all
    const n = f.calls.length;
    await publishIndexHealth(f.d1, 's1', report(0), null);
    expect(f.calls.length).toBe(n);
  });

  it('a D1 failure keeps the old signature so the next drain retries', async () => {
    const d1 = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('d1 down');
          },
        }),
      }),
    };
    expect(await publishIndexHealth(d1, 's1', report(1), null)).toBeNull();
  });
});

describe('hourly health cron alerts ONE aggregated P1 per run', () => {
  const seed = (f: ReturnType<typeof fakeD1>, r: DeadLetterReport) =>
    f.kv.set(
      indexHealthKey('s1'),
      JSON.stringify({
        storeId: 's1',
        dead: r.dead,
        abandoned: r.abandoned,
        rows: r.rows,
        updatedAt: 1,
      })
    );
  const sent = () => vi.fn().mockResolvedValue('sent');

  it('no health rows -> no alert', async () => {
    const f = fakeD1();
    const send = sent();
    expect(await alertEntityIndexHealth(f.d1, send as never)).toEqual({ stores: 0, alerted: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('ONE aggregated P1 for N rows; the next hours stay quiet; a day later it alerts again', async () => {
    const f = fakeD1();
    seed(f, report(2));
    const send = sent();
    const t0 = Date.UTC(2026, 10, 6, 10);
    expect((await alertEntityIndexHealth(f.d1, send as never, t0)).alerted).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ level: 'p1' });
    expect(send.mock.calls[0]![0].body).toMatch(/2 entity-index row\(s\) in 1 store\(s\)/);
    expect((await alertEntityIndexHealth(f.d1, send as never, t0 + 3600_000)).alerted).toBe(0);
    expect((await alertEntityIndexHealth(f.d1, send as never, t0 + 23 * 3600_000)).alerted).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await alertEntityIndexHealth(f.d1, send as never, t0 + 25 * 3600_000)).alerted).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rows across several stores still make ONE send', async () => {
    const f = fakeD1();
    for (const id of ['a', 'b', 'c'])
      f.kv.set(
        indexHealthKey(id),
        JSON.stringify({ storeId: id, dead: 1, abandoned: 0, rows: report(1).rows, updatedAt: 1 })
      );
    const send = sent();
    expect((await alertEntityIndexHealth(f.d1, send as never, 1)).alerted).toBe(3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].body).toMatch(/3 entity-index row\(s\) in 3 store\(s\)/);
  });

  it('a store marked deleted: no alert, health + dedupe rows removed; a store merely missing from the directory still alerts', async () => {
    const f = fakeD1();
    for (const id of ['gone', 'missing'])
      f.kv.set(
        indexHealthKey(id),
        JSON.stringify({ storeId: id, dead: 1, abandoned: 0, rows: report(1).rows, updatedAt: 1 })
      );
    f.kv.set(`${ALERTED_PREFIX}gone`, JSON.stringify({ '1': 1 }));
    f.deletedStores.add('gone');
    const send = sent();
    const r = await alertEntityIndexHealth(f.d1, send as never, 5);
    expect(r).toEqual({ stores: 1, alerted: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].body).toContain('missing:');
    expect(send.mock.calls[0]![0].body).not.toContain('gone:');
    expect(f.kv.has(indexHealthKey('gone'))).toBe(false);
    expect(f.kv.has(`${ALERTED_PREFIX}gone`)).toBe(false);
    expect(f.kv.has(indexHealthKey('missing'))).toBe(true);
  });

  it('101 stores: the directory lookup is chunked to <= 100 bound params', async () => {
    const f = fakeD1();
    for (let i = 0; i < 101; i++)
      f.kv.set(
        indexHealthKey(`s${i}`),
        JSON.stringify({
          storeId: `s${i}`,
          dead: 1,
          abandoned: 0,
          rows: report(1).rows,
          updatedAt: 1,
        })
      );
    f.deletedStores.add('s100');
    const send = sent();
    const r = await alertEntityIndexHealth(f.d1, send as never, 5);
    expect(Math.max(...f.maxParams)).toBeLessThanOrEqual(100);
    expect(f.maxParams.length).toBe(2);
    expect(f.kv.has(indexHealthKey('s100'))).toBe(false); // deleted store in the 2nd chunk is cleared
    expect(r.stores).toBe(100);
  });

  it('an alert that was not sent (throttled/failed) is retried on the next tick', async () => {
    const f = fakeD1();
    seed(f, report(1));
    const send = vi.fn().mockResolvedValueOnce('failed').mockResolvedValue('sent');
    const t0 = Date.UTC(2026, 10, 6, 10);
    expect((await alertEntityIndexHealth(f.d1, send as never, t0)).alerted).toBe(0);
    expect((await alertEntityIndexHealth(f.d1, send as never, t0 + 3600_000)).alerted).toBe(1);
  });

  it('an abandoned row says so; a recovered store forgets its dedupe state', async () => {
    const f = fakeD1();
    seed(f, report(1, true));
    const send = sent();
    await alertEntityIndexHealth(f.d1, send as never, 5);
    expect(send.mock.calls[0]![0].body).toMatch(/1 abandoned/);
    expect(f.kv.has(`${ALERTED_PREFIX}s1`)).toBe(true);
    f.kv.delete(`${INDEX_HEALTH_PREFIX}s1`); // the DO wrote the row and cleared the health row
    await alertEntityIndexHealth(f.d1, send as never, 6);
    expect(f.kv.has(`${ALERTED_PREFIX}s1`)).toBe(false);
  });
});
