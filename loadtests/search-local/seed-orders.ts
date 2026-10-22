// LOCAL ONLY (Task 14): add orders + registered customers to a store made by seed.ts, so the admin
// order search and the customer typeahead can be measured. 10 % of the orders belong to registered
// customers (one customer per ~2 orders), the rest are guest orders with the contact only in the
// shipping-address JSON, like production.
//   DATABASE_URL=<owner url> npx tsx loadtests/search-local/seed-orders.ts <store slug> <orders>
import { createPrismaClient } from '@ebda/database';

async function main() {
  const slug = process.argv[2] ?? 'load-20000';
  const orders = Number(process.argv[3] ?? 20000);
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url))
    throw new Error('refusing: DATABASE_URL is not loopback');
  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  const store = await prisma.store.findFirstOrThrow({ where: { slug }, select: { id: true } });
  const registered = Math.floor(orders / 10);
  const users = Math.max(1, Math.floor(registered / 2));
  const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM public.orders WHERE store_id = ${store.id}`;
  if (Number(n) > 0) {
    console.log(JSON.stringify({ storeId: store.id, reused: true, orders: Number(n) }));
    return prisma.$disconnect();
  }
  const tag = slug.replace(/[^a-z0-9]/g, '');
  await prisma.$executeRaw`
    INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at)
    SELECT ${tag} || '-u' || g, ${store.id}, 'ru' || md5(${tag} || 're' || g) || '@x.test', 'x',
           'uf' || md5('uf' || g), 'ul' || md5('ul' || g), '+2012' || lpad(g::text, 8, '0'), 'customer', now()
    FROM generate_series(1, ${users}::int) g`;
  await prisma.$executeRaw`
    INSERT INTO public.orders
      (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, updated_at)
    SELECT ${tag} || '-o' || g, ${store.id}, 'EB' || upper(md5(${tag} || 'o' || g)), 1000, 1000,
           CASE WHEN g <= ${registered}::int THEN '{}'::jsonb ELSE jsonb_build_object(
             'firstName', 'gf' || md5('gf' || g), 'lastName', 'gl' || md5('gl' || g),
             'email', 'ge' || md5('ge' || g) || '@x.test', 'phone', '+2011' || lpad(g::text, 8, '0')) END,
           '{}'::jsonb,
           CASE WHEN g <= ${registered}::int THEN ${tag} || '-u' || ((g % ${users}::int) + 1) END, now()
    FROM generate_series(1, ${orders}::int) g`;
  await prisma.$executeRaw`ANALYZE public.orders`;
  await prisma.$executeRaw`ANALYZE public.users`;
  console.log(JSON.stringify({ storeId: store.id, orders, users }));
  await prisma.$disconnect();
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
