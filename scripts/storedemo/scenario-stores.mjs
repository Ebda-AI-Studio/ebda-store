#!/usr/bin/env node
// Local scenario stores for the Qamar and Souq matrices (tests/qamar, tests/souq). LOOPBACK
// DATABASES ONLY: there is no --yes-production path. Each store is a NON-demo merchant store switched to a look through
// StoreService.applyLook(..., { design: 'reset' }), then shaped:
//   qamar-empty   0 products            qamar-one   1 product
//   qamar-500     500 generated products, every 5th without an image
//   qamar-edge-wide / -tall / -nologo   logo shapes; Arabic-Indic numerals ON (NUMERALS-1:
//                 theme.arabicNumerals); merchant primaryColor at the extremes '0 0% 98%' / '60 100% 50%'
//
// Souq (--template souq, Phase B2): souq-empty, souq-one, souq-500, souq-noimg (no product photo),
// souq-longnames (60+ character names), souq-edge-light / -dark (merchant primary at the extremes),
// souq-logo-wide / -tall / -none, souq-white-photos (Night with white-background merchant photos),
// souq-cod (the plain COD catalogue; card visuals are covered by the PaymentStep unit render,
// Ruling B1-20, so there is no card-provider store: it would need provider credentials).
//
//   DATABASE_URL=<owner-role local postgres url> QAMAR_DEMO_ASSET_BASE=/__qamar-demo \
//     npx tsx scripts/storedemo/scenario-stores.mjs [--template qamar|souq]
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  isLocalUrl,
  hostOf,
  assetBase,
  seedCatalogue,
  seedStoreClaim,
  templateFromArgv,
} from './seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** [slug, look, shape] */
export const QAMAR_SCENARIOS = [
  ['qamar-empty', 'qamar.atelier', { products: 0 }],
  ['qamar-one', 'qamar.lookbook', { products: 1 }],
  ['qamar-500', 'qamar.vitrine', { products: 500 }],
  ['qamar-edge-wide', 'qamar.atelier', { edge: 'wide', primary: '0 0% 98%' }],
  ['qamar-edge-tall', 'qamar.lookbook', { edge: 'tall', primary: '60 100% 50%' }],
  ['qamar-edge-nologo', 'qamar.vitrine', { edge: 'nologo', primary: '0 0% 98%' }],
];

export const SOUQ_SCENARIOS = [
  ['souq-empty', 'souq.catalogue', { products: 0 }],
  ['souq-one', 'souq.showroom', { products: 1 }],
  ['souq-500', 'souq.catalogue', { products: 500 }],
  ['souq-noimg', 'souq.night', { noImages: true }],
  ['souq-longnames', 'souq.catalogue', { longNames: true }],
  ['souq-edge-light', 'souq.catalogue', { edge: 'wide', primary: '0 0% 98%' }],
  ['souq-edge-dark', 'souq.night', { edge: 'tall', primary: '0 0% 4%' }],
  ['souq-logo-wide', 'souq.showroom', { edge: 'wide' }],
  ['souq-logo-tall', 'souq.catalogue', { edge: 'tall' }],
  ['souq-logo-none', 'souq.night', { edge: 'nologo' }],
  ['souq-white-photos', 'souq.night', { whitePhotos: true }],
  ['souq-cod', 'souq.catalogue', {}],
];
export const SCENARIOS = QAMAR_SCENARIOS;

const svg = (w, h, word = 'QAMAR') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#222"/><text x="50%" y="50%" fill="#fff" font-size="${Math.min(w, h) / 3}" text-anchor="middle" dominant-baseline="middle">${word}</text></svg>`;
/** A merchant cut-out shot on pure white: grey device on #FFFFFF (Review Focus 2). */
const whitePhoto = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><rect width="800" height="800" fill="#ffffff"/><rect x="290" y="120" width="220" height="560" rx="36" fill="#9aa3ad"/><rect x="306" y="150" width="188" height="480" rx="12" fill="#dfe3e8"/></svg>`;

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url || !isLocalUrl(url)) {
    console.error(`Refusing: scenario stores are local only (host "${hostOf(url ?? '')}").`);
    process.exit(2);
  }
  const spec = templateFromArgv(process.argv.slice(2));
  if (!spec) {
    console.error('Unknown --template; expected qamar or souq.');
    process.exit(2);
  }
  const isSouq = spec.template === 'souq';
  const SCENARIO_LIST = isSouq ? SOUQ_SCENARIOS : QAMAR_SCENARIOS;
  const assetDir = isSouq ? '__souq-demo' : '__qamar-demo';
  const LOGO_DIR = resolve(root, `apps/web/public/${assetDir}`);
  const word = isSouq ? 'SOUQ' : 'QAMAR';
  const a = assetBase([], process.env, spec);
  process.env.DIRECT_URL ??= url;
  const { createPrismaClient, Prisma, runInStoreScope } = await import('@ebda/database');
  const { StoreService } = await import(`${root}/apps/api/src/services/store.service.ts`);
  const { getPageState, publishDraft } = await import(
    `${root}/apps/api/src/services/page-builder.service.ts`
  );
  const { invalidateStoreProductCaches } = await import(`${root}/apps/api/src/lib/public-cache.ts`);
  mkdirSync(LOGO_DIR, { recursive: true });
  writeFileSync(resolve(LOGO_DIR, 'logo-wide.svg'), svg(600, 60, word));
  writeFileSync(resolve(LOGO_DIR, 'logo-tall.svg'), svg(60, 400, word));
  writeFileSync(resolve(LOGO_DIR, 'white-photo.svg'), whitePhoto);
  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  try {
    const owner = await prisma.user.findFirst({ where: { email: spec.ownerEmail, storeId: null } });
    if (!owner) throw new Error('run scripts/storedemo/seed.mjs first (it creates the owner)');
    for (const [slug, lookId, shape] of SCENARIO_LIST) {
      const edge = shape.edge;
      const data = {
        // A store's display name is never its slug (STOP-2: "souq-noimg" leaked into a hero).
        name: isSouq ? 'Cairo Electronics' : 'Heliopolis Boutique',
        nameAr: isSouq ? 'القاهرة للإلكترونيات' : 'بوتيك مصر الجديدة',
        isDemo: false,
        status: 'active',
        plan: 'professional',
        logo:
          edge === 'wide'
            ? `/${assetDir}/logo-wide.svg`
            : edge === 'tall'
              ? `/${assetDir}/logo-tall.svg`
              : null,
      };
      // Ruling B2-17: never take over a store the seed does not own.
      const held = await prisma.store.findUnique({
        where: { slug },
        select: { id: true, isDemo: true, ownerId: true },
      });
      const claim = seedStoreClaim(held, owner, { demo: false });
      if (!claim.ok) throw new Error(`refusing to touch store "${slug}": ${claim.why}`);
      const s = await prisma.store.upsert({
        where: { slug },
        update: data,
        create: {
          slug,
          ownerId: owner.id,
          template: spec.template,
          theme: {},
          currency: 'EGP',
          ...data,
        },
      });
      await runInStoreScope(s.id, async () => {
        await seedCatalogue(prisma, Prisma, s.id, a.base, spec);
        if (shape.products === 0) {
          await prisma.product.updateMany({
            where: { storeId: s.id },
            data: { status: 'archived' },
          });
        } else if (shape.products === 1) {
          await prisma.product.updateMany({
            where: { storeId: s.id, slug: { not: isSouq ? 'smartphone-6-7' : 'linen-abaya' } },
            data: { status: 'archived' },
          });
        } else if (shape.products === 500) {
          const cat = await prisma.category.findFirst({
            where: { storeId: s.id, slug: isSouq ? 'phones' : 'abayas' },
          });
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
              url: isSouq ? `${a.base}/smartphone.webp` : `${a.base}/linen-abaya-1.webp`,
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
        if (shape.noImages || shape.whitePhotos) {
          const ids = (
            await prisma.product.findMany({ where: { storeId: s.id }, select: { id: true } })
          ).map(p => p.id);
          await prisma.productImage.deleteMany({ where: { productId: { in: ids } } });
          if (shape.whitePhotos)
            await prisma.productImage.createMany({
              data: ids.map(productId => ({
                productId,
                url: `/${assetDir}/white-photo.svg`,
                alt: 'white background photo',
                position: 0,
              })),
            });
        }
        if (shape.longNames) {
          const rows = await prisma.product.findMany({
            where: { storeId: s.id },
            select: { id: true, name: true, nameAr: true },
          });
          for (const r of rows)
            await prisma.product.update({
              where: { id: r.id, storeId: s.id },
              data: {
                name: `${r.name} with an exceptionally long merchant written title that must wrap or truncate`,
                nameAr: `${r.nameAr} بعنوان طويل جدا كتبه التاجر لازم يلف على سطرين او يتقص من غير ما يكسر الكارت`,
              },
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
        if (edge || shape.primary) {
          const row = await prisma.store.findUnique({
            where: { id: s.id },
            select: { theme: true },
          });
          await prisma.store.update({
            where: { id: s.id },
            data: {
              theme: {
                ...(row?.theme ?? {}),
                ...(shape.primary ? { primaryColor: shape.primary } : {}),
                arabicNumerals: !!shape.primary,
              },
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
