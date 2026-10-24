// Copies ONE demo store's catalogue from production Postgres into the spike StoreDO.
// Postgres access is READ-ONLY: a single SELECT in a session forced to default_transaction_read_only=on.
// Usage: PG_URL=<read url> node scripts/seed-from-pg.mjs --store-id <uuid> --worker <https://...> [--dry-run]
//   SEED_TOKEN=<operator token>   (the worker's __seed route is closed without it)
// The connection string is read from the PG_URL env var only; it is never printed.
import { spawnSync } from 'node:child_process';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const storeId = arg('store-id');
const worker = arg('worker');
const dry = process.argv.includes('--dry-run');
if (!storeId || !/^[0-9a-f-]{36}$/.test(storeId)) throw new Error('--store-id <uuid> required');
if (!process.env.PG_URL) throw new Error('PG_URL env var required');
if (!dry && (!worker || !process.env.SEED_TOKEN))
  throw new Error('--worker and SEED_TOKEN required');

const ms = col => `(extract(epoch from ${col}) * 1000)::bigint`;
const query = `
select json_build_object(
  'store', (select json_build_object('id', id, 'slug', slug, 'name', name, 'currency', 'EGP',
            'createdAt', ${ms('created_at')}, 'updatedAt', ${ms('updated_at')})
            from stores where id = '${storeId}'),
  'products', coalesce((select json_agg(json_build_object(
      'id', p.id, 'storeId', p.store_id, 'name', p.name, 'nameAr', p.name_ar, 'slug', p.slug,
      'price', p.price, 'compareAtPrice', p.compare_at_price, 'inventory', p.inventory,
      'status', p.status::text,
      'hasVariants', exists(select 1 from product_variants v where v.product_id = p.id and v.is_active),
      'createdAt', ${ms('p.created_at')}, 'updatedAt', ${ms('p.updated_at')}))
      from products p where p.store_id = '${storeId}' and p.status::text in ('active','draft','archived')), '[]'::json),
  'variants', coalesce((select json_agg(json_build_object(
      'id', v.id, 'storeId', p.store_id, 'productId', v.product_id, 'sku', v.sku,
      'price', coalesce(v.price, p.price), 'inventory', v.inventory, 'isActive', v.is_active,
      'createdAt', ${ms('v.created_at')}, 'updatedAt', ${ms('v.updated_at')}))
      from product_variants v join products p on p.id = v.product_id
      where p.store_id = '${storeId}'), '[]'::json)
)`;

const r = spawnSync(
  'psql',
  [process.env.PG_URL, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query],
  {
    env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }
);
if (r.status !== 0)
  throw new Error(`psql failed: ${r.stderr.replace(process.env.PG_URL, '<PG_URL>').slice(0, 400)}`);
const rows = JSON.parse(r.stdout.trim().split('\n').pop());
if (!rows.store) throw new Error('store not found');
console.log(
  `read: store=${rows.store.slug} products=${rows.products.length} variants=${rows.variants.length}`
);
if (dry) process.exit(0);

// 100 products per request keeps each DO call small; the DO upserts idempotently.
let sent = 0;
for (let i = 0; i < Math.max(rows.products.length, 1); i += 100) {
  const slice = rows.products.slice(i, i + 100);
  const ids = new Set(slice.map(p => p.id));
  const res = await fetch(`${worker.replace(/\/$/, '')}/s/${storeId}/__seed`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SEED_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      store: rows.store,
      products: slice,
      variants: rows.variants.filter(v => ids.has(v.productId)),
    }),
  });
  if (!res.ok) throw new Error(`seed failed ${res.status} ${await res.text()}`);
  sent += slice.length;
}
console.log(`seeded ${sent} products into ${worker}`);
