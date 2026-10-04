import { describe, expect, it } from 'vitest';
import { api, ENV_DB } from './helpers';

// SP4 Stage 2: a small pool of Prisma clients per isolate, each leased to ONE request at a time and
// reused (engines are built once, not per request); the pg connection is per request.
// /__dev/probe (src/cf/dev-stats.ts, DEV_STATS=1) runs one transaction on the request's own
// connection and says which pooled client and which connection scope served it.
interface Probe {
  clientId: string;
  scopeId: number;
  first: number;
  second: number;
  nestedPid?: number;
}
interface Stats {
  pool: { created: number; leased: number; idle: number; waiting: number; max: number };
}

const probe = async (ms: number, ip: string, extra = ''): Promise<Probe> => {
  const res = await api.fetch(`https://api.ebda.app/__dev/probe?ms=${ms}${extra}`, {
    headers: { 'cf-connecting-ip': ip },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Probe;
};
const stats = async (): Promise<Stats> =>
  (await (await api.fetch('https://api.ebda.app/__dev/stats')).json()) as Stats;
const settled = async (): Promise<Stats> => {
  // releases run in waitUntil, after the response
  let s = await stats();
  for (let i = 0; i < 50 && s.pool.leased !== 0; i++) {
    await new Promise(r => setTimeout(r, 100));
    s = await stats();
  }
  return s;
};

describe.skipIf(!ENV_DB())('leased clients, one connection per request (workerd)', () => {
  it('two concurrent requests use different connections AND different clients', async () => {
    // 300 ms of pg_sleep inside the transaction: the two requests certainly overlap, so each
    // must hold its own server connection (a shared one could not serve both at once), and each
    // must hold its own client: a client shared by concurrent requests loses writes in workerd
    // (Prisma's DataLoader dispatches the second request's query from the first request's context).
    const [a, b] = await Promise.all([probe(300, '10.31.0.1'), probe(300, '10.31.0.2')]);
    expect(a.scopeId).not.toBe(b.scopeId);
    expect(a.first).not.toBe(b.first);
    expect(a.clientId).not.toBe(b.clientId);
    // inside one transaction the connection never changes (the RLS GUC model)
    expect(a.first).toBe(a.second);
    expect(b.first).toBe(b.second);
  });

  it('a request may hold a second transaction while its first is open (the API does: withMoneyTx in runInTenantContext)', async () => {
    // One connection per request deadlocked here until pg's 10 s connect timeout (the
    // order-refunded fan-out failed on Workers in the buy-flow parity run).
    const t0 = Date.now();
    const r = await probe(20, '10.34.0.1', '&nested=1');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.nestedPid).toBeTypeOf('number');
    expect(r.first).toBe(r.second);
  });

  it('sequential requests reuse the same client on a new connection each time', async () => {
    await settled();
    const first = await probe(10, '10.33.0.1');
    await settled();
    const second = await probe(10, '10.33.0.2');
    expect(second.clientId).toBe(first.clientId); // the pooled client (engine) is reused ...
    expect(second.scopeId).toBeGreaterThan(first.scopeId); // ... on a fresh per-request connection
    // (a connection cached with the client would be an I/O object of the first request: workerd
    // refuses to use it from the second, and the probe would fail instead of answering 200)
  });

  it('many concurrent requests: no hang, clients bounded by the pool, every lease released', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => probe(50, `10.32.0.${i + 1}`))
    );
    expect(new Set(results.map(r => r.scopeId)).size).toBe(40);
    for (const r of results) expect(r.first).toBe(r.second);
    const s = await settled();
    expect(s.pool.created).toBeLessThanOrEqual(s.pool.max);
    expect(s.pool.leased).toBe(0);
    expect(s.pool.waiting).toBe(0);
    expect(new Set(results.map(r => r.clientId)).size).toBeLessThanOrEqual(s.pool.max);
  });
});
