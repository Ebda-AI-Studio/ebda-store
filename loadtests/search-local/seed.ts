// LOCAL ONLY (Task 14): seed a store of N products (names derived from the eval catalogue so the
// eval queries have real answers), then index it with BOTH vectors using the fake embedder.
//   DATABASE_URL=<owner url> REDIS_URL=<redis> npx tsx loadtests/search-local/seed.mts 2000
// Prints {"storeId": ...}. Refuses a non-loopback database. Owner role: fixtures only.
import { readFileSync } from 'node:fs';
import { createPrismaClient, runInStoreScope } from '@ebda/database';
import { catalogueRows } from '../../tests/search-eval/catalogue';
import { makeFakeProvider, NO_LATENCY } from './fake-embed';
import { setEmbeddingProviderForTests } from '../../apps/api/src/lib/search/embedding-provider';

async function main() {
  const N = Number(process.argv[2] ?? 2000);
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url))
    throw new Error('refusing: DATABASE_URL is not loopback');
  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });

  const terms: Record<string, string | null> = JSON.parse(
    readFileSync(new URL('../../tests/search-eval/ai-terms.json', import.meta.url), 'utf8')
  ).terms;
  const AR = [
    'أسود',
    'أبيض',
    'أزرق',
    'أحمر',
    'قطن',
    'جلد',
    'صيفي',
    'شتوي',
    'اقتصادي',
    'فاخر',
    'جديد',
    'كبير',
    'صغير',
    'مميز',
    'أنيق',
  ];
  const EN = [
    'black',
    'white',
    'blue',
    'red',
    'cotton',
    'leather',
    'summer',
    'winter',
    'economy',
    'premium',
    'new',
    'large',
    'small',
    'special',
    'classic',
  ];

  const slug = `load-${N}`;
  const email = 'load-owner@example.test';
  let owner = await prisma.user.findFirst({ where: { email } });
  owner =
    owner ??
    (await prisma.user.create({
      data: {
        email,
        passwordHash: 'x',
        firstName: 'Load',
        lastName: 'Owner',
        role: 'store_admin',
        emailVerified: true,
        status: 'active',
        language: 'ar',
      },
    }));
  const existing = await prisma.store.findFirst({ where: { slug } });
  if (existing) {
    console.log(JSON.stringify({ storeId: existing.id, reused: true }));
    await prisma.$disconnect();
    process.exit(0);
  }
  const store = await prisma.store.create({
    data: {
      name: `Load ${N}`,
      nameAr: `متجر ${N}`,
      slug,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
      template: 'modern',
      theme: {},
      settings: { defaultLanguage: 'ar' },
    },
  });

  const base = catalogueRows();
  const rows = Array.from({ length: N }, (_, i) => {
    const b = base[i % base.length];
    const round = Math.floor(i / base.length);
    const a = (i * 7 + round) % AR.length;
    const c = (i * 3 + round * 5) % AR.length;
    const suffix = round === 0 ? '' : ` ${AR[a]} ${AR[c]} ${round}`;
    const suffixEn = round === 0 ? '' : ` ${EN[a]} ${EN[c]} ${round}`;
    return {
      storeId: store.id,
      slug: `${b.id}-${i}`,
      name: `${b.name}${suffixEn}`,
      nameAr: `${b.nameAr}${suffix}`,
      searchTerms: (terms[b.id] ?? '').slice(0, 500) || null,
      price: 5000 + ((i * 137) % 90000),
      inventory: 5 + (i % 40),
      status: 'active' as const,
      description: `${b.name} high quality`,
      descriptionAr: `${b.nameAr} جودة عالية`,
    };
  });
  for (let i = 0; i < rows.length; i += 1000)
    await prisma.product.createMany({ data: rows.slice(i, i + 1000) });
  const made = await prisma.product.findMany({
    where: { storeId: store.id },
    select: { id: true },
  });
  for (let i = 0; i < made.length; i += 2000)
    await prisma.productImage.createMany({
      data: made.slice(i, i + 2000).map((p, j) => ({
        productId: p.id,
        url: `https://img.example.test/${i + j}.jpg`,
        alt: 'p',
        position: 0,
      })),
    });
  console.error(`[seed] ${made.length} products`);

  setEmbeddingProviderForTests(makeFakeProvider(NO_LATENCY));
  process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP = '1000000';
  process.env.SEARCH_EMBED_STORE_DAILY_CAP = '1000000';
  const { indexStore } = await import('../../apps/api/src/services/product-index.service');
  const { redis } = await import('../../apps/api/src/services/redis.service');
  await redis.connect?.();
  const t0 = Date.now();
  for (;;) {
    const r = await runInStoreScope(store.id, () =>
      indexStore(store.id, { batchSize: 100, maxDocs: 2000 })
    );
    if (!r.remaining) break;
    if (r.capped) throw new Error('indexer capped');
  }
  console.error(`[seed] indexed in ${Date.now() - t0} ms`);
  console.log(JSON.stringify({ storeId: store.id }));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
