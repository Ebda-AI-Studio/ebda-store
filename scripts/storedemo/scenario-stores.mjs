#!/usr/bin/env node
// Local scenario stores for the Qamar, Souq, Jasmine and Lamma matrices (tests/qamar, tests/souq, tests/jasmine, tests/lamma). LOOPBACK
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
// Jasmine (--template jasmine, Phase B3): jasmine-empty, jasmine-one, jasmine-500 (cursor pagination),
// jasmine-noimg, jasmine-longnames, jasmine-edge-light / -dark, jasmine-logo-wide / -tall / -none,
// jasmine-white-photos (Apothecary with white-background merchant photos: the dark look on real
// merchant content, quality bar section 9 rule 1) and jasmine-cod. There is no card-provider store:
// the card method is the PaymentStep unit render (B1-20).
//
// Lamma (--template lamma, Phase B4): lamma-empty, lamma-one, lamma-500, lamma-noimg, lamma-longnames,
// lamma-edge-light / -dark, lamma-logo-wide / -tall / -none, lamma-white-photos (Notebook with
// white-background merchant photos), lamma-reorder (a customer with two paid orders: the only store
// where the "order again" row renders, Ruling B4-9), lamma-dates (a Friday off day with the made-to-order
// lead times) and lamma-cod. The card method is the PaymentStep unit render (B1-20).
//
// Dahab (--template dahab, Phase B5): dahab-empty, dahab-one (a gold-rate chain: the single-product shape
// still shows a gold line), dahab-500, dahab-noimg, dahab-longnames, dahab-edge-light / -dark,
// dahab-logo-wide / -tall / -none, dahab-white-photos (Workshop with white-background merchant photos),
// dahab-cod, dahab-legacy (a store created on the retired skin, `look` NULL, moved onto Worn through
// applyLook(keep), the migration path of Ruling B5-3) and dahab-gold (the gold E2E store: its owner can
// log in, dahab-gold-owner@example.test, so a test can change the rate through the admin API).
// Every Dahab store is gold-priced with the demo's manual rates (seedGold).
//
//   DATABASE_URL=<owner-role local postgres url> QAMAR_DEMO_ASSET_BASE=/__qamar-demo \
//     npx tsx scripts/storedemo/scenario-stores.mjs [--template qamar|souq|jasmine|lamma|dahab]
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// bcryptjs is an API dependency, resolved from there (the scenario seed has no package of its own).
const bcrypt = createRequire(import.meta.url)('bcryptjs');
import {
  isLocalUrl,
  hostOf,
  assetBase,
  seedCatalogue,
  seedGold,
  seedStoreClaim,
  templateFromArgv,
  SHOWROOM_THEME,
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
export const JASMINE_SCENARIOS = [
  ['jasmine-empty', 'jasmine.clinic', { products: 0 }],
  ['jasmine-one', 'jasmine.bloom', { products: 1 }],
  ['jasmine-500', 'jasmine.clinic', { products: 500 }],
  ['jasmine-noimg', 'jasmine.apothecary', { noImages: true }],
  ['jasmine-longnames', 'jasmine.bloom', { longNames: true }],
  ['jasmine-edge-light', 'jasmine.clinic', { edge: 'wide', primary: '0 0% 98%' }],
  ['jasmine-edge-dark', 'jasmine.apothecary', { edge: 'tall', primary: '0 0% 4%' }],
  ['jasmine-logo-wide', 'jasmine.bloom', { edge: 'wide' }],
  ['jasmine-logo-tall', 'jasmine.clinic', { edge: 'tall' }],
  ['jasmine-logo-none', 'jasmine.apothecary', { edge: 'nologo' }],
  ['jasmine-white-photos', 'jasmine.apothecary', { whitePhotos: true }],
  ['jasmine-cod', 'jasmine.clinic', {}],
];
export const LAMMA_SCENARIOS = [
  ['lamma-empty', 'lamma.table', { products: 0 }],
  ['lamma-one', 'lamma.notebook', { products: 1 }],
  ['lamma-500', 'lamma.market', { products: 500 }],
  ['lamma-noimg', 'lamma.table', { noImages: true }],
  ['lamma-longnames', 'lamma.market', { longNames: true }],
  ['lamma-edge-light', 'lamma.market', { edge: 'wide', primary: '0 0% 98%' }],
  ['lamma-edge-dark', 'lamma.table', { edge: 'tall', primary: '0 0% 4%' }],
  ['lamma-logo-wide', 'lamma.table', { edge: 'wide' }],
  ['lamma-logo-tall', 'lamma.notebook', { edge: 'tall' }],
  ['lamma-logo-none', 'lamma.market', { edge: 'nologo' }],
  // Notebook with white-background merchant photos: the dark look on real merchant content
  // (quality bar section 9 rule 1, Review Focus 2).
  ['lamma-white-photos', 'lamma.notebook', { whitePhotos: true }],
  // A registered customer with two PAID orders: the only store where "order again" renders
  // (a demo store refuses customers, Ruling B4-9). Login: lamma-reorder-customer@example.test.
  ['lamma-reorder', 'lamma.market', { reorder: true }],
  // The delivery-date chips with a Friday off day (store calendar) and the made-to-order lead times.
  ['lamma-dates', 'lamma.table', { dates: true }],
  ['lamma-cod', 'lamma.table', {}],
];
export const DAHAB_SCENARIOS = [
  ['dahab-empty', 'dahab.worn', { products: 0 }],
  ['dahab-one', 'dahab.workshop', { products: 1 }],
  ['dahab-500', 'dahab.giftbox', { products: 500 }],
  ['dahab-noimg', 'dahab.worn', { noImages: true }],
  ['dahab-longnames', 'dahab.workshop', { longNames: true }],
  ['dahab-edge-light', 'dahab.giftbox', { edge: 'wide', primary: '0 0% 98%' }],
  ['dahab-edge-dark', 'dahab.worn', { edge: 'tall', primary: '0 0% 4%' }],
  ['dahab-logo-wide', 'dahab.workshop', { edge: 'wide' }],
  ['dahab-logo-tall', 'dahab.giftbox', { edge: 'tall' }],
  ['dahab-logo-none', 'dahab.worn', { edge: 'nologo' }],
  // Workshop is a committed teal page: white-background merchant photos must sit on a light band
  // (quality bar section 9 rule 1).
  ['dahab-white-photos', 'dahab.workshop', { whitePhotos: true }],
  ['dahab-cod', 'dahab.giftbox', {}],
  // A store that was on the retired night + gold skin (`look` NULL) and was moved onto Worn with
  // `design: 'keep'`: its own theme overrides survive on top of the new look (Ruling B5-3).
  ['dahab-legacy', 'dahab.worn', { legacy: true }],
  // The gold E2E store: a merchant who can log in, to change the rate through the admin API.
  ['dahab-gold', 'dahab.worn', { goldOwner: true }],
  // The same merchant on the other two looks: the purchase-path pack shoots the two gold screens per look.
  ['dahab-gold-workshop', 'dahab.workshop', { goldOwner: true }],
  ['dahab-gold-giftbox', 'dahab.giftbox', { goldOwner: true }],
];
export const SCENARIOS = QAMAR_SCENARIOS;

/** What differs per template: the lists, display names, asset dir, the one-product slug and the 500-store category/photo. */
const PER_TEMPLATE = {
  qamar: {
    list: QAMAR_SCENARIOS,
    assetDir: '__qamar-demo',
    word: 'QAMAR',
    name: 'Heliopolis Boutique',
    nameAr: 'بوتيك مصر الجديدة',
    one: 'linen-abaya',
    category: 'abayas',
    photo: 'linen-abaya-1.webp',
  },
  souq: {
    list: SOUQ_SCENARIOS,
    assetDir: '__souq-demo',
    word: 'SOUQ',
    name: 'Cairo Electronics',
    nameAr: 'القاهرة للإلكترونيات',
    one: 'smartphone-6-7',
    category: 'phones',
    photo: 'smartphone.webp',
  },
  jasmine: {
    list: JASMINE_SCENARIOS,
    assetDir: '__jasmine-demo',
    word: 'JASMINE',
    name: 'Cairo Beauty',
    nameAr: 'القاهرة للجمال',
    one: 'niacinamide-serum',
    category: 'cleansers',
    photo: 'gentle-cleanser.webp',
  },
  lamma: {
    list: LAMMA_SCENARIOS,
    assetDir: '__lamma-demo',
    word: 'LAMMA',
    name: 'Om Salma Kitchen',
    nameAr: 'مطبخ أم سلمى',
    one: 'okra-tagine',
    category: 'produce',
    photo: 'tomatoes.webp',
  },
  dahab: {
    list: DAHAB_SCENARIOS,
    assetDir: '__dahab-demo',
    word: 'DAHAB',
    name: 'Cairo Jewellery',
    nameAr: 'مجوهرات القاهرة',
    one: 'gold-chain-21',
    category: 'rings',
    photo: 'ring-silver.webp',
  },
};

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
    console.error('Unknown --template; expected qamar, souq, jasmine, lamma or dahab.');
    process.exit(2);
  }
  const T = PER_TEMPLATE[spec.template];
  const SCENARIO_LIST = T.list;
  const assetDir = T.assetDir;
  const LOGO_DIR = resolve(root, `apps/web/public/${assetDir}`);
  const word = T.word;
  const a = assetBase([], process.env, spec);
  process.env.DIRECT_URL ??= url;
  const { createPrismaClient, Prisma, runInStoreScope } = await import('@ebda/database');
  const { StoreService } = await import(`${root}/apps/api/src/services/store.service.ts`);
  const { getPageState, publishDraft } = await import(
    `${root}/apps/api/src/services/page-builder.service.ts`
  );
  const { invalidateStoreProductCaches } = await import(`${root}/apps/api/src/lib/public-cache.ts`);
  const { GoldRateService } = await import(
    `${root}/apps/api/src/services/gold-rate/gold-rate.service.ts`
  );
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
        name: T.name,
        nameAr: T.nameAr,
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
      // dahab-gold belongs to a merchant who can log in (so a test can use the admin API); every other
      // scenario store belongs to the seed owner.
      let storeOwner = owner;
      if (shape.goldOwner) {
        const email = 'dahab-gold-owner@example.test';
        storeOwner =
          (await prisma.user.findFirst({ where: { email, storeId: null } })) ??
          (await prisma.user.create({
            data: {
              email,
              passwordHash: await bcrypt.hash('Gold-Owner-1', 10),
              firstName: 'Gold',
              lastName: 'Owner',
              role: 'store_admin',
              emailVerified: true,
            },
          }));
      }
      const claim = seedStoreClaim(held, storeOwner, { demo: false });
      if (!claim.ok) throw new Error(`refusing to touch store "${slug}": ${claim.why}`);
      const s = await prisma.store.upsert({
        where: { slug },
        update: data,
        create: {
          slug,
          ownerId: storeOwner.id,
          template: spec.template,
          theme: SHOWROOM_THEME,
          currency: 'EGP',
          ...data,
        },
      });
      await runInStoreScope(s.id, async () => {
        const seeded = await seedCatalogue(prisma, Prisma, s.id, a.base, spec);
        // Phase B5: every Dahab store prices its gold pieces from the demo's manual rates.
        if (spec.gold)
          await seedGold(
            prisma,
            s.id,
            storeOwner.id,
            spec,
            seeded.productIdBySlug,
            GoldRateService
          );
        if (shape.products === 0) {
          await prisma.product.updateMany({
            where: { storeId: s.id },
            data: { status: 'archived' },
          });
        } else if (shape.products === 1) {
          await prisma.product.updateMany({
            where: { storeId: s.id, slug: { not: T.one } },
            data: { status: 'archived' },
          });
        } else if (shape.products === 500) {
          const cat = await prisma.category.findFirst({
            where: { storeId: s.id, slug: T.category },
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
              url: `${a.base}/${T.photo}`,
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
        // A customer with two PAID orders (Ruling B4-8): the reorder row's only live exercise.
        if (shape.reorder) {
          const email = 'lamma-reorder-customer@example.test';
          const passwordHash = await bcrypt.hash('Reorder-Customer-1', 10);
          const cust =
            (await prisma.user.findFirst({ where: { email, storeId: s.id } })) ??
            (await prisma.user.create({
              data: {
                email,
                storeId: s.id,
                passwordHash,
                firstName: 'Reorder',
                lastName: 'Customer',
                role: 'customer',
                emailVerified: true,
              },
            }));
          const prods = await prisma.product.findMany({
            where: {
              storeId: s.id,
              status: 'active',
              slug: { in: ['okra-tagine', 'kofta-grilled', 'tomatoes', 'fresh-milk'] },
            },
            select: { id: true, name: true, slug: true, price: true },
          });
          const addr = {
            firstName: 'Reorder',
            lastName: 'Customer',
            address1: 'Demo',
            city: 'Cairo',
            country: 'EG',
          };
          for (const [n, slugs] of [
            [1, ['okra-tagine', 'tomatoes']],
            [2, ['kofta-grilled', 'fresh-milk']],
          ]) {
            const orderNumber = `LAMMA-RO-${s.id.slice(0, 8)}-${n}`;
            if (await prisma.order.findUnique({ where: { orderNumber } })) continue;
            const items = prods.filter(p => slugs.includes(p.slug));
            const total = items.reduce((sum, p) => sum + p.price, 0);
            await prisma.order.create({
              data: {
                storeId: s.id,
                customerId: cust.id,
                orderNumber,
                status: 'delivered',
                paymentStatus: 'paid',
                subtotal: total,
                total,
                shippingAddress: addr,
                billingAddress: addr,
                createdAt: new Date(Date.now() - n * 86_400_000),
                items: {
                  create: items.map(p => ({
                    productId: p.id,
                    productName: p.name,
                    quantity: 1,
                    price: p.price,
                    total: p.price,
                  })),
                },
              },
            });
          }
        }
        if (shape.legacy) {
          // The retired skin: no look, the merchant's own theme on top (what `keep` must preserve).
          await prisma.store.update({
            where: { id: s.id },
            data: {
              look: null,
              theme: { ...SHOWROOM_THEME, primaryColor: '36 52% 40%' },
            },
          });
        }
        const r = await StoreService.applyLook(
          s.id,
          lookId,
          { design: shape.legacy ? 'keep' : 'reset' },
          storeOwner.id
        );
        if (r.builder === 'draft') {
          const state = await getPageState(s.id, 'home');
          const pub = await publishDraft({ storeId: s.id, pageKey: 'home', baseRev: state.rev });
          // A re-run applies the same look again: nothing new to publish is not a failure.
          if (!pub.ok && !/not ready/i.test(pub.message))
            throw new Error(`publishDraft: ${pub.message}`);
        }
        if (shape.dates) {
          const row = await prisma.store.findUnique({
            where: { id: s.id },
            select: { settings: true },
          });
          await prisma.store.update({
            where: { id: s.id },
            data: { settings: { ...(row?.settings ?? {}), deliveryOffDays: [5] } },
          });
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
