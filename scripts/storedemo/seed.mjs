#!/usr/bin/env node
// Seed the looks DEMO store (slug `storedemo`, is_demo = true): the showroom that previews every
// built look through `?look=<id>` (apps/web/src/lib/demo-look.ts) and refuses every order.
//
//   DATABASE_URL=<owner-role postgres url> npx tsx scripts/storedemo/seed.mjs [--yes-production]
//
// Prints the plan first. Refuses any non-local DATABASE_URL (anything but loopback) unless
// `--yes-production` is passed: Ahmad approves that run, an agent never does. Idempotent: the owner
// and store are upserted, categories and products are upserted on (store, slug), re-running updates
// in place and never duplicates.
//
// Catalogue: a small bilingual list per look family (one category each: Qamar fashion, Souq
// electronics, Jasmine beauty, Lamma home and kitchen, Dahab jewellery), prices in piastres.
// No images: nothing is uploaded to R2 here and no URL is invented. Product photos are a follow-up
// (the looks render their image-less card until then).
//
// The store's theme is written as {} on purpose: the demo preview composes skin + look with no
// merchant overrides, and a showroom must show the look itself.
import { pathToFileURL } from 'node:url';

export const SLUG = 'storedemo';
export const OWNER_EMAIL = 'storedemo-owner@ebda.app';
export const DEFAULT_LOOK = 'qamar.atelier';

/** [slug, name, nameAr, piastres] */
export const CATALOGUE = [
  {
    template: 'qamar',
    category: { slug: 'fashion', name: 'Fashion', nameAr: 'أزياء' },
    products: [
      ['linen-shirt', 'Linen shirt', 'قميص كتان', 89000],
      ['wide-trousers', 'Wide-leg trousers', 'بنطلون واسع', 129000],
      ['wool-scarf', 'Wool scarf', 'وشاح صوف', 54000],
      ['leather-belt', 'Leather belt', 'حزام جلد', 39000],
    ],
  },
  {
    template: 'souq',
    category: { slug: 'electronics', name: 'Electronics', nameAr: 'إلكترونيات' },
    products: [
      ['wireless-earbuds', 'Wireless earbuds', 'سماعات لاسلكية', 149900],
      ['power-bank', 'Power bank 20,000 mAh', 'باور بانك 20 ألف', 99900],
      ['smart-watch', 'Smart watch', 'ساعة ذكية', 249900],
      ['phone-stand', 'Aluminium phone stand', 'حامل موبايل ألمنيوم', 24900],
    ],
  },
  {
    template: 'jasmine',
    category: { slug: 'beauty', name: 'Beauty', nameAr: 'جمال' },
    products: [
      ['rose-serum', 'Rose face serum', 'سيروم الورد', 74900],
      ['argan-oil', 'Argan hair oil', 'زيت الأرجان', 49900],
      ['clay-mask', 'Green clay mask', 'ماسك الطين الأخضر', 34900],
      ['body-butter', 'Shea body butter', 'زبدة الشيا للجسم', 42900],
    ],
  },
  {
    template: 'lamma',
    category: { slug: 'home-kitchen', name: 'Home and kitchen', nameAr: 'البيت والمطبخ' },
    products: [
      ['stoneware-mug', 'Stoneware mug', 'مج فخار', 19900],
      ['olive-board', 'Olive wood board', 'لوح خشب زيتون', 64900],
      ['linen-napkins', 'Linen napkins, set of 4', 'فوط كتان، 4 قطع', 38900],
      ['copper-pot', 'Copper coffee pot', 'كنكة نحاس', 57900],
    ],
  },
  {
    template: 'dahab',
    category: { slug: 'jewellery', name: 'Jewellery', nameAr: 'مجوهرات' },
    products: [
      ['gold-chain', '18K gold chain', 'سلسلة دهب عيار 18', 1850000],
      ['signet-ring', 'Signet ring', 'خاتم', 1250000],
      ['hoop-earrings', 'Hoop earrings', 'حلقان دايرة', 980000],
      ['bangle', 'Plain bangle', 'غويشة سادة', 2100000],
    ],
  },
];

// pg-connection-string is the parser the pg driver itself uses (transitive dep of pg; not declared
// here on purpose), so locality is decided from the host the driver will actually connect to.
import { createRequire } from 'node:module';
const { parse: parsePgUrl } = createRequire(import.meta.url)('pg-connection-string');

/** The host pg will connect to ('' when none/unparseable). A unix-socket path starts with '/'. */
export function hostOf(url) {
  try {
    new URL(url);
    return String(parsePgUrl(url).host ?? '')
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
  } catch {
    return null;
  }
}
/** `?host=` / `?hostaddr=` can redirect the connection away from the URL authority: never trusted. */
export function overridesHost(url) {
  try {
    const q = new URL(url).searchParams;
    return q.has('host') || q.has('hostaddr');
  } catch {
    return true;
  }
}
export const isLocalUrl = url => {
  if (overridesHost(url)) return false;
  const h = hostOf(url);
  return h !== null && (['localhost', '127.0.0.1', '::1'].includes(h) || h.startsWith('/'));
};

/** The human-readable plan, printed before anything is written. */
export function describePlan(url) {
  const n = CATALOGUE.reduce((s, c) => s + c.products.length, 0);
  return [
    `target database host: ${hostOf(url) ?? '(unparseable DATABASE_URL)'}`,
    `store: slug "${SLUG}", is_demo = true, look ${DEFAULT_LOOK}, theme {} (owner ${OWNER_EMAIL}, no login)`,
    `categories: ${CATALOGUE.length} (${CATALOGUE.map(c => c.category.slug).join(', ')})`,
    `products: ${n} (${CATALOGUE.length} families x ${CATALOGUE[0].products.length}), status active, stock 50, no images`,
    'idempotent: upsert owner/store, upsert categories + products on (store, slug)',
  ].join('\n');
}

/** Exit code the guard decides on: 0 = go, 2 = refuse. Pure so it is unit-tested. */
export function guard(url, argv) {
  if (!url || hostOf(url) === null)
    return { ok: false, why: 'DATABASE_URL is missing or invalid.' };
  if (!isLocalUrl(url) && !argv.includes('--yes-production')) {
    return {
      ok: false,
      why: `Refusing non-local database host "${hostOf(url)}" without --yes-production.`,
    };
  }
  return { ok: true };
}

async function run() {
  const url = process.env.DATABASE_URL;
  console.log(describePlan(url));
  const g = guard(url, process.argv.slice(2));
  if (!g.ok) {
    console.error(g.why);
    process.exit(2);
  }
  process.env.DIRECT_URL ??= url;

  const { createPrismaClient } = await import('@ebda/database');
  const { getLook } = await import('@ebda/shared');
  const look = getLook(DEFAULT_LOOK);
  if (!look) throw new Error(`default look ${DEFAULT_LOOK} is not in the registry`);

  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  try {
    await prisma.$transaction(async tx => {
      const owner =
        (await tx.user.findFirst({ where: { email: OWNER_EMAIL, storeId: null } })) ??
        (await tx.user.create({
          data: {
            email: OWNER_EMAIL,
            passwordHash: '!seed-no-login',
            firstName: 'Store',
            lastName: 'Demo',
            role: 'store_admin',
            emailVerified: true,
          },
        }));
      const base = {
        name: 'Ebda Demo',
        nameAr: 'إبدا ديمو',
        template: look.skin,
        look: look.id,
        theme: {},
        isDemo: true,
        status: 'active',
        currency: 'EGP',
      };
      const store = await tx.store.upsert({
        where: { slug: SLUG },
        update: base,
        create: { ...base, slug: SLUG, ownerId: owner.id },
      });
      for (const [pos, fam] of CATALOGUE.entries()) {
        const cat = await tx.category.upsert({
          where: { storeId_slug: { storeId: store.id, slug: fam.category.slug } },
          update: { name: fam.category.name, nameAr: fam.category.nameAr, position: pos },
          create: { storeId: store.id, ...fam.category, position: pos },
        });
        for (const [i, [slug, name, nameAr, price]] of fam.products.entries()) {
          const product = await tx.product.upsert({
            where: { storeId_slug: { storeId: store.id, slug } },
            update: { name, nameAr, price, status: 'active' },
            create: {
              storeId: store.id,
              slug,
              name,
              nameAr,
              price,
              inventory: 50,
              status: 'active',
              featured: i < 2,
            },
          });
          await tx.productCategory.upsert({
            where: { productId_categoryId: { productId: product.id, categoryId: cat.id } },
            update: { position: i },
            create: { productId: product.id, categoryId: cat.id, position: i },
          });
        }
      }
      console.log(`seeded store ${store.id} (${SLUG})`);
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
