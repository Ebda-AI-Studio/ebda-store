#!/usr/bin/env node
// Local scenario stores for the Qamar matrix (tests/qamar). LOOPBACK DATABASES ONLY: there is no
// --yes-production path. Each store is a NON-demo merchant store switched to a Qamar look through
// StoreService.applyLook(..., { design: 'reset' }), then shaped:
//   qamar-empty   0 products            qamar-one   1 product
//   qamar-500     500 generated products, every 5th without an image
//   qamar-edge-wide / -tall / -nologo   logo shapes; Arabic-Indic numerals ON (NUMERALS-1:
//                 theme.arabicNumerals); merchant primaryColor at the extremes '0 0% 98%' / '60 100% 50%'
//
//   DATABASE_URL=<owner-role local postgres url> QAMAR_DEMO_ASSET_BASE=/__qamar-demo \
//     npx tsx scripts/storedemo/scenario-stores.mjs
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isLocalUrl, hostOf, assetBase, seedCatalogue, OWNER_EMAIL } from './seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOGO_DIR = resolve(root, 'apps/web/public/__qamar-demo');

/** [slug, look, shape] */
export const SCENARIOS = [
  ['qamar-empty', 'qamar.atelier', { products: 0 }],
  ['qamar-one', 'qamar.lookbook', { products: 1 }],
  ['qamar-500', 'qamar.vitrine', { products: 500 }],
  ['qamar-edge-wide', 'qamar.atelier', { edge: 'wide', primary: '0 0% 98%' }],
  ['qamar-edge-tall', 'qamar.lookbook', { edge: 'tall', primary: '60 100% 50%' }],
  ['qamar-edge-nologo', 'qamar.vitrine', { edge: 'nologo', primary: '0 0% 98%' }],
];

const svg = (w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#222"/><text x="50%" y="50%" fill="#fff" font-size="${Math.min(w, h) / 3}" text-anchor="middle" dominant-baseline="middle">QAMAR</text></svg>`;

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url || !isLocalUrl(url)) {
    console.error(`Refusing: scenario stores are local only (host "${hostOf(url ?? '')}").`);
    process.exit(2);
  }
  const a = assetBase([], process.env);
  process.env.DIRECT_URL ??= url;
  const { createPrismaClient, Prisma, runInStoreScope } = await import('@ebda/database');
  const { StoreService } = await import(`${root}/apps/api/src/services/store.service.ts`);
  const { getPageState, publishDraft } = await import(
    `${root}/apps/api/src/services/page-builder.service.ts`
  );
  const { invalidateStoreProductCaches } = await import(`${root}/apps/api/src/lib/public-cache.ts`);
  mkdirSync(LOGO_DIR, { recursive: true });
  writeFileSync(resolve(LOGO_DIR, 'logo-wide.svg'), svg(600, 60));
  writeFileSync(resolve(LOGO_DIR, 'logo-tall.svg'), svg(60, 400));
  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  try {
    const owner = await prisma.user.findFirst({ where: { email: OWNER_EMAIL, storeId: null } });
    if (!owner) throw new Error('run scripts/storedemo/seed.mjs first (it creates the owner)');
    for (const [slug, lookId, shape] of SCENARIOS) {
      const edge = shape.edge;
      const data = {
        name: `Scenario ${slug}`,
        nameAr: `سيناريو ${slug}`,
        isDemo: false,
        status: 'active',
        plan: 'professional',
        logo:
          edge === 'wide'
            ? '/__qamar-demo/logo-wide.svg'
            : edge === 'tall'
              ? '/__qamar-demo/logo-tall.svg'
              : null,
      };
      const s = await prisma.store.upsert({
        where: { slug },
        update: data,
        create: { slug, ownerId: owner.id, template: 'qamar', theme: {}, currency: 'EGP', ...data },
      });
      await runInStoreScope(s.id, async () => {
        await seedCatalogue(prisma, Prisma, s.id, a.base);
        if (shape.products === 0) {
          await prisma.product.updateMany({
            where: { storeId: s.id },
            data: { status: 'archived' },
          });
        } else if (shape.products === 1) {
          await prisma.product.updateMany({
            where: { storeId: s.id, slug: { not: 'linen-abaya' } },
            data: { status: 'archived' },
          });
        } else if (shape.products === 500) {
          const cat = await prisma.category.findFirst({ where: { storeId: s.id, slug: 'abayas' } });
          for (let b = 0; b < 5; b++) {
            const rows = Array.from({ length: 100 }, (_, i) => {
              const n = b * 100 + i + 1;
              return {
                storeId: s.id,
                slug: `sample-${n}`,
                name: `Sample product ${n}`,
                nameAr: `منتج تجريبي رقم ${n}`,
                price: 10000 + (n % 40) * 2500,
                inventory: 10,
                status: 'active',
              };
            });
            await prisma.product.createMany({ data: rows, skipDuplicates: true });
          }
          const made = await prisma.product.findMany({
            where: { storeId: s.id, slug: { startsWith: 'sample-' } },
            select: { id: true, slug: true, nameAr: true },
          });
          const withImage = made.filter(p => Number(p.slug.slice(7)) % 5 !== 0);
          await prisma.productImage.deleteMany({
            where: { productId: { in: made.map(p => p.id) } },
          });
          await prisma.productImage.createMany({
            data: withImage.map(p => ({
              productId: p.id,
              url: `${a.base}/linen-abaya-1.webp`,
              alt: p.nameAr,
              position: 0,
            })),
          });
          if (cat)
            await prisma.productCategory.createMany({
              data: made.map((p, position) => ({ productId: p.id, categoryId: cat.id, position })),
              skipDuplicates: true,
            });
        }
        const r = await StoreService.applyLook(s.id, lookId, { design: 'reset' }, owner.id);
        if (r.builder === 'draft') {
          const state = await getPageState(s.id, 'home');
          const pub = await publishDraft({ storeId: s.id, pageKey: 'home', baseRev: state.rev });
          // A re-run applies the same look again: nothing new to publish is not a failure.
          if (!pub.ok && !/not ready/i.test(pub.message))
            throw new Error(`publishDraft: ${pub.message}`);
        }
        if (edge) {
          const row = await prisma.store.findUnique({
            where: { id: s.id },
            select: { theme: true },
          });
          await prisma.store.update({
            where: { id: s.id },
            data: {
              theme: { ...(row?.theme ?? {}), primaryColor: shape.primary, arabicNumerals: true },
            },
          });
        }
      });
      await invalidateStoreProductCaches(s.id);
      console.log(`scenario ${slug} (${s.id}) on ${lookId}`);
    }
  } catch (err) {
    process.exitCode = 1;
    console.error('scenario seed failed:', err);
  } finally {
    await prisma.$disconnect().catch(() => {});
    setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
