// LOCAL ONLY (Task 14): latency of the admin order search and the customer typeahead as the
// strict-RLS role `ebda_app` under a store scope, at a fixed concurrency. These call the production
// service functions directly (the HTTP routes need an admin login; the SQL is the same).
// One process = one worker (concurrent tenant transactions in ONE process serialise on the shared
// request-db context); run several processes in parallel and merge BENCH_OUT files (bench-orders.sh).
//   DATABASE_URL=<owner url> npx tsx loadtests/search-local/bench-orders.ts <slug> [concurrency] [seconds] [suffix]
// suffix '.old' benchmarks order.service.old.ts / customer-search.service.old.ts (temporary copies).
import { createPrismaClient, runWithRequestDb, runInTenantContext, prisma } from '@ebda/database';

async function main() {
  const slug = process.argv[2] ?? 'load-20000';
  const conc = Number(process.argv[3] ?? 8);
  const secs = Number(process.argv[4] ?? 20);
  const suf = process.argv[5] ?? '';
  const owner = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(owner)) throw new Error('refusing: not loopback');
  const u = new URL(owner);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  const app = createPrismaClient({ connectionString: u.toString(), max: conc + 2 });
  const { orderSearchWhere } = await import(`../../apps/api/src/services/order.service${suf}`);
  const { searchOrderCustomers } = await import(
    `../../apps/api/src/services/customer-search.service${suf}`
  );
  const ownerDb = createPrismaClient({ connectionString: owner, role: 'owner' });
  const store = await ownerDb.store.findFirstOrThrow({ where: { slug }, select: { id: true } });
  const storeId = store.id;
  // Terms taken from real rows so every search finds something: 10-char slices of each field.
  const rows = await ownerDb.$queryRaw<Array<{ t: string; k: string }>>`
    (SELECT substr(order_number, 3, 10) t, 'num' k FROM orders WHERE store_id = ${storeId} ORDER BY random() LIMIT 40)
    UNION ALL (SELECT substr(shipping_address->>'firstName', 3, 10), 'gf' FROM orders WHERE store_id = ${storeId} AND customer_id IS NULL ORDER BY random() LIMIT 40)
    UNION ALL (SELECT substr(shipping_address->>'email', 3, 10), 'ge' FROM orders WHERE store_id = ${storeId} AND customer_id IS NULL ORDER BY random() LIMIT 40)
    UNION ALL (SELECT right(shipping_address->>'phone', 7), 'gp' FROM orders WHERE store_id = ${storeId} AND customer_id IS NULL ORDER BY random() LIMIT 40)
    UNION ALL (SELECT substr(first_name, 3, 10), 'uf' FROM users WHERE store_id = ${storeId} ORDER BY random() LIMIT 40)
    UNION ALL (SELECT substr(email, 3, 10), 'ue' FROM users WHERE store_id = ${storeId} ORDER BY random() LIMIT 40)`;
  console.error('sampled', rows.length);
  const lat: Record<string, number[]> = { list: [], customers: [] };
  const end = Date.now() + secs * 1000;
  const worker = async () => {
    while (Date.now() < end) {
      const { t } = rows[Math.floor(Math.random() * rows.length)];
      const isList = Math.random() < 0.7;
      const t0 = performance.now();
      try {
        await runWithRequestDb(
          () => app,
          () =>
            runInTenantContext(storeId, async () => {
              if (isList) {
                const arms = await orderSearchWhere(storeId, t);
                await prisma.order.findMany({
                  where: { storeId, deletedAt: null, OR: arms },
                  select: { id: true },
                  take: 20,
                });
              } else await searchOrderCustomers(storeId, t);
            })
        );
        lat[isList ? 'list' : 'customers'].push(performance.now() - t0);
      } catch (e) {
        console.error('ITER ERR', String(e).slice(0, 300));
        await new Promise(r => setTimeout(r, 200));
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  const q = (a: number[], p: number) =>
    [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
  for (const [k, a] of Object.entries(lat))
    console.log(
      `${k.padEnd(10)} n=${a.length} p50=${q(a, 0.5).toFixed(0)} p95=${q(a, 0.95).toFixed(0)} p99=${q(a, 0.99).toFixed(0)} max=${Math.max(...a).toFixed(0)} ms`
    );
  console.log(
    `throughput ${((lat.list.length + lat.customers.length) / secs).toFixed(0)} req/s at concurrency ${conc}`
  );
  if (process.env.BENCH_OUT)
    (await import('node:fs')).writeFileSync(process.env.BENCH_OUT, JSON.stringify(lat));
  await app.$disconnect();
  await ownerDb.$disconnect();
  process.exit(0);
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
