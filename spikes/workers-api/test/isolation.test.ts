import { describe, it, expect } from 'vitest';
import { AMELIA, RIVAL, call, rawTx, pmap } from './helpers';

describe('tenant isolation through pgbouncer (transaction mode, pool_size=2) on workerd', () => {
  it('300 interleaved concurrent requests (amelia/rival + no-GUC probes): 0 leaks, pooled connections shared across tenants', async () => {
    const N = 300;
    let leaks = 0,
      bad = 0;
    const pidsByTenant: Record<string, Set<string>> = { amelia: new Set(), rival: new Set() };
    const t0 = performance.now();
    const lat: number[] = [];
    await pmap(
      Array.from({ length: N }, (_, i) => i),
      30,
      async i => {
        if (i % 5 === 4) {
          // probe: a transaction that NEVER sets the GUC, landing on pooled server connections
          // that just served other tenants. It must see nothing.
          const seen = await rawTx(async tx => ({
            products: await tx.product.count(),
            guc: (
              await tx.$queryRaw<
                { v: string | null }[]
              >`SELECT current_setting('app.current_store_id', true) AS v`
            )[0].v,
          }));
          if (seen.products !== 0 || (seen.guc ?? '') !== '') leaks++;
          return;
        }
        const t = i % 2 === 0 ? AMELIA : RIVAL;
        const s = performance.now();
        const res = await call(t.host, '/products');
        lat.push(performance.now() - s);
        if (res.status !== 200) {
          bad++;
          return;
        }
        const body = (await res.json()) as {
          storeId: string;
          products: { storeId: string; name: string }[];
        };
        pidsByTenant[t.prefix.toLowerCase()].add(res.headers.get('x-ebda-backend-pid') ?? '?');
        if (
          body.storeId !== t.id ||
          body.products.length !== t.n ||
          body.products.some(p => p.storeId !== t.id || !p.name.startsWith(t.prefix))
        )
          leaks++;
      }
    );
    lat.sort((a, b) => a - b);
    const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1);
    const all = new Set([...pidsByTenant.amelia, ...pidsByTenant.rival]);
    const shared = [...pidsByTenant.amelia].filter(p => pidsByTenant.rival.has(p));
    console.log(
      `[load] ${N} ops in ${(performance.now() - t0).toFixed(0)}ms; latency p50=${q(0.5)}ms p95=${q(0.95)}ms max=${q(1)}ms; leaks=${leaks} bad=${bad}; distinct backend pids=${all.size} (${[...all]}); pids serving BOTH tenants=${shared.length}`
    );
    expect(bad).toBe(0);
    expect(leaks).toBe(0);
    expect(all.size).toBeLessThanOrEqual(2);
    expect(shared.length).toBeGreaterThan(0); // connection reuse across tenants really happened
  });

  it('role is non-bypass and every table is ENABLE+FORCE RLS', async () => {
    const role = await rawTx(
      tx =>
        tx.$queryRaw<
          { u: string; bypass: boolean; su: boolean }[]
        >`SELECT current_user::text AS u, rolbypassrls AS bypass, rolsuper AS su FROM pg_roles WHERE rolname = current_user`
    );
    expect(role[0]).toEqual({ u: 'ebda_app', bypass: false, su: false });
    const t = await rawTx(
      tx =>
        tx.$queryRaw<
          { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >`SELECT relname::text AS relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('stores','products','carts','cart_items','webhook_events') AND relkind='r'`
    );
    expect(t).toHaveLength(5);
    for (const r of t)
      expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it('a request whose GUC is not set returns zero rows, and cannot write', async () => {
    expect(await rawTx(tx => tx.product.count())).toBe(0);
    expect(await rawTx(tx => tx.product.findMany())).toEqual([]);
    expect(await rawTx(tx => tx.cart.count())).toBe(0);
    await expect(
      rawTx(tx =>
        tx.product.create({
          data: { id: crypto.randomUUID(), storeId: AMELIA.id, name: 'x', pricePiastres: 1 },
        })
      )
    ).rejects.toThrow();
    // and stores is not even granted to ebda_app (host lookup only via the SECURITY DEFINER fn)
    await expect(rawTx(tx => tx.store.count())).rejects.toThrow(/permission denied/);
  });

  it('transaction-local set_config does not leak to the next tenant on a reused pooled connection', async () => {
    let reused = 0,
      leaks = 0;
    let prevPid: number | undefined;
    for (let i = 0; i < 40; i++) {
      const a = await rawTx(
        async tx => ({
          pid: (await tx.$queryRaw<{ p: number }[]>`SELECT pg_backend_pid() AS p`)[0].p,
          inTx: (
            await tx.$queryRaw<
              { v: string }[]
            >`SELECT current_setting('app.current_store_id', true) AS v`
          )[0].v,
        }),
        AMELIA.id
      );
      expect(a.inTx).toBe(AMELIA.id); // GUC is visible inside its own tx
      const b = await rawTx(async tx => ({
        pid: (await tx.$queryRaw<{ p: number }[]>`SELECT pg_backend_pid() AS p`)[0].p,
        v: (
          await tx.$queryRaw<
            { v: string | null }[]
          >`SELECT current_setting('app.current_store_id', true) AS v`
        )[0].v,
        n: await tx.product.count(),
      })); // "rival" connection that has NOT set its own GUC yet
      if (b.pid === a.pid) reused++;
      if ((b.v ?? '') !== '' || b.n !== 0) leaks++;
      prevPid = b.pid;
    }
    console.log(
      `[reuse] 40 amelia->unscoped pairs: same backend pid in ${reused}/40; leaks=${leaks}`
    );
    expect(reused).toBeGreaterThan(0); // the test really exercised reuse
    expect(leaks).toBe(0);
  });

  it('NEGATIVE CONTROL: a session-level set_config(..., false) DOES leak through pgbouncer (proves the harness can fail)', async () => {
    // Uses a private probe GUC so it cannot disturb the RLS tests that follow.
    let leaks = 0;
    for (let i = 0; i < 20; i++) {
      const marker = `amelia-${i}`;
      await rawTx(tx => tx.$queryRaw`SELECT set_config('app.leak_probe', ${marker}, false)`); // is_local = false
      const seen = await rawTx(
        async tx =>
          (
            await tx.$queryRaw<
              { v: string | null }[]
            >`SELECT current_setting('app.leak_probe', true) AS v`
          )[0].v
      );
      if (seen === marker) leaks++;
    }
    console.log(
      `[negative-control] session-level set_config leaked into a later, different client ${leaks}/20 times`
    );
    expect(leaks).toBeGreaterThan(0);
    // clean both pooled connections (pool_size=2) so nothing lingers
    await pmap([0, 1, 2, 3, 4, 5], 6, () =>
      rawTx(tx => tx.$queryRaw`SELECT set_config('app.leak_probe', '', false)`)
    );
  });
});
