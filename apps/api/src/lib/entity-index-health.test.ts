import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/alerts.service', () => ({ sendAlert: vi.fn() }));
import { alertEntityIndexHealth, ALERTED_PREFIX } from './entity-index-health';
import { INDEX_HEALTH_PREFIX } from '../cf/store-do/index-health';

const row = (n: number, abandoned = false) => ({
  outboxId: n,
  kind: 'order',
  id: `o${n}`,
  attempts: 5,
  abandoned,
});
const health = (rows: ReturnType<typeof row>[]) =>
  JSON.stringify({ dead: rows.length, abandoned: rows.filter(r => r.abandoned).length, rows });

function fakeD1(settings: Record<string, string>, liveIds: string[]) {
  const deleted: string[] = [];
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...v: unknown[]) {
          return {
            async all() {
              if (sql.includes('FROM stores'))
                return {
                  results: (v as string[]).filter(id => liveIds.includes(id)).map(id => ({ id })),
                };
              return { results: Object.entries(settings).map(([key, value]) => ({ key, value })) };
            },
            async run() {
              if (sql.startsWith('DELETE')) deleted.push(String(v[0]));
              return {};
            },
          };
        },
      };
    },
  };
  return { d1, deleted };
}

describe('alertEntityIndexHealth', () => {
  it('sends ONE aggregated alert for many dead rows across stores', async () => {
    const { d1 } = fakeD1(
      {
        [`${INDEX_HEALTH_PREFIX}s1`]: health([row(1), row(2), row(3)]),
        [`${INDEX_HEALTH_PREFIX}s2`]: health([row(4)]),
      },
      ['s1', 's2']
    );
    const send = vi.fn(async () => 'sent' as const);
    const r = await alertEntityIndexHealth(d1, send as never, 1_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].body).toMatch(/4 entity-index row\(s\) in 2 store\(s\)/);
    expect(r.alerted).toBe(4);
  });

  it('does not alert for a deleted store and removes its health + dedupe rows', async () => {
    const { d1, deleted } = fakeD1(
      {
        [`${INDEX_HEALTH_PREFIX}gone`]: health([row(1)]),
        [`${ALERTED_PREFIX}gone`]: JSON.stringify({ '1': 1 }),
      },
      []
    );
    const send = vi.fn(async () => 'sent' as const);
    await alertEntityIndexHealth(d1, send as never, 1_000);
    expect(send).not.toHaveBeenCalled();
    expect(deleted).toContain(`${INDEX_HEALTH_PREFIX}gone`);
    expect(deleted).toContain(`${ALERTED_PREFIX}gone`);
  });
});
