import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { routeCutover } from '../src/cf/cutover';
import type { CfBindings } from '../src/cf/bindings';

// The real StoreDO behind routeCutover(): the bearer is checked in the Worker, the handler runs in the DO.
const SECRET = 'c'.repeat(32);
const e = { ...(env as unknown as CfBindings), CUTOVER_IMPORT_SECRET: SECRET } as CfBindings;
const auth = { authorization: `Bearer ${SECRET}` };
const id = () => crypto.randomUUID();
const call = (store: string, action: string, init: RequestInit = {}) =>
  routeCutover(
    new Request(`https://api.ebda.app/cutover/stores/${store}/${action}`, {
      method: action === '__status' ? 'GET' : 'POST',
      headers: auth,
      ...init,
    }),
    e
  ) as Promise<Response>;

// `stores` lives in D1 now; the StoreDO carries the per-store tables, so the cutover pages target affiliate_configs.
const page = (n: number) =>
  [
    JSON.stringify({
      batch: 'cut-test-1',
      table: 'affiliate_configs',
      page: n,
      columns: ['id', 'store_id'],
      pk: ['id'],
    }),
    JSON.stringify([`s${n}`, `st${n}`]),
  ].join('\n');

describe('cutover admin surface on the real StoreDO', () => {
  it('imports a page, replays it as a no-op, and reports status', async () => {
    const s = id();
    const a = await call(s, '__import', { body: page(0) });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { skipped: boolean }).skipped).toBe(false);
    const b = await call(s, '__import', { body: page(0) });
    expect(((await b.json()) as { skipped: boolean }).skipped).toBe(true);
    const st = (await (await call(s, '__status')).json()) as { sealed: boolean; ledger: unknown[] };
    expect(st.sealed).toBe(false);
    expect(st.ledger).toHaveLength(1);
  });

  it('__seal makes a later __import return 423, and __unseal reopens it', async () => {
    const s = id();
    expect((await call(s, '__import', { body: page(0) })).status).toBe(200);
    expect((await call(s, '__seal')).status).toBe(200);
    expect((await call(s, '__import', { body: page(1) })).status).toBe(423);
    expect(((await (await call(s, '__status')).json()) as { sealed: boolean }).sealed).toBe(true);
    const bad = await call(s, '__unseal', { body: JSON.stringify({ confirm: 'yes' }) });
    expect(bad.status).toBe(400);
    const ok = await call(s, '__unseal', { body: JSON.stringify({ confirm: 'wipe-and-unseal' }) });
    expect(ok.status).toBe(200);
    expect((await call(s, '__import', { body: page(1) })).status).toBe(200);
  });

  it('__verify returns a digest per table', async () => {
    const s = id();
    await call(s, '__import', { body: page(0) });
    const r = await call(s, '__verify', {
      body: JSON.stringify({
        tables: [
          {
            table: 'affiliate_configs',
            columns: ['id', 'store_id'],
            pk: ['id'],
          },
        ],
      }),
    });
    const j = (await r.json()) as { tables: { affiliate_configs: { count: number } } };
    expect(j.tables.affiliate_configs.count).toBe(1);
  });

  it('no bearer: 401 and nothing is written', async () => {
    const s = id();
    const r = await routeCutover(
      new Request(`https://api.ebda.app/cutover/stores/${s}/__import`, {
        method: 'POST',
        body: page(0),
      }),
      e
    );
    expect(r?.status).toBe(401);
    expect(
      ((await (await call(s, '__status')).json()) as { ledger: unknown[] }).ledger
    ).toHaveLength(0);
  });
});
