#!/usr/bin/env node
// Seed a looks DEMO store (is_demo = true): the showroom that previews every built look of its
// template through `?look=<id>` (apps/web/src/lib/demo-look.ts) and refuses every order. One demo
// store per template (Ruling B2-7): `storedemo` = Qamar (default), `storedemo-souq` = Souq
// (`--template souq`, SOUQ_DEMO_ASSET_BASE, prod asset base https://media.ebda.app/demo/souq).
//
//   DATABASE_URL=<owner-role postgres url> [QAMAR_DEMO_ASSET_BASE=<url or /path>] \
//     npx tsx scripts/storedemo/seed.mjs [--template qamar|souq] [--yes-production] [--local-look-stores]
//
// Prints the plan first. Refuses any non-local DATABASE_URL (anything but loopback) unless
// `--yes-production` is passed: Ahmad approves that run, an agent never does (Ruling B1-16), and with
// it every photo URL must be under https://media.ebda.app/demo/qamar. Idempotent: owner, store,
// categories and products are upserted, size charts and the shipping zone are found-then-updated,
// variants are found by SKU and never deleted (cart lines may point at them).
//
// Catalogue: the Qamar demo boutique (scripts/qamar-demo/catalogue.mjs, Phase B1 Task 6), with
// illustrative photos (Ruling TPL-3) served from QAMAR_DEMO_ASSET_BASE. The Phase S placeholder
// families (fashion, electronics, beauty, home and kitchen, jewellery) are ARCHIVED, never deleted
// (Ruling B1-15, plan amendment C3). The home page is the Qamar superset document
// (scripts/storedemo/qamar-home.mjs), saved and published through the page-builder service.
//
// --local-look-stores (refused with --yes-production) also seeds three NON-demo stores,
// qamar-atelier / qamar-lookbook / qamar-vitrine, each switched to its look through
// StoreService.applyLook(..., { design: 'reset' }) - the real merchant path - for local review.
//
// The store's theme is written as {} on purpose: the demo preview composes skin + look with no
// merchant overrides, and a showroom must show the look itself.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  QAMAR_CATEGORIES,
  QAMAR_OCCASIONS,
  QAMAR_PRODUCTS,
  QAMAR_SIZE_CHARTS,
} from '../qamar-demo/catalogue.mjs';
import { SOUQ_CATEGORIES, SOUQ_PRODUCTS } from '../souq-demo/catalogue.mjs';
import { buildQamarHome } from './qamar-home.mjs';
import { buildSouqHome } from './souq-home.mjs';

export { buildQamarHome, buildSouqHome };

export const SLUG = 'storedemo';
export const OWNER_EMAIL = 'storedemo-owner@ebda.app';
export const DEFAULT_LOOK = 'qamar.atelier';

/**
 * Phase S placeholder families: no longer seeded, only ARCHIVED on an existing showroom (B1-15, C3).
 * [slug, name, nameAr, piastres]
 */
export const PHASE_S_PLACEHOLDERS = [
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

export const PLACEHOLDER_SLUGS = PHASE_S_PLACEHOLDERS.flatMap(f => f.products.map(p => p[0]));
export const PLACEHOLDER_CATEGORY_SLUGS = PHASE_S_PLACEHOLDERS.map(f => f.category.slug);
/** Local review stores (`--local-look-stores`): slug -> look id. Never on production. */
export const LOCAL_LOOK_STORES = [
  ['qamar-atelier', 'qamar.atelier'],
  ['qamar-lookbook', 'qamar.lookbook'],
  ['qamar-vitrine', 'qamar.vitrine'],
];

/** The only asset base a production run accepts (Ruling B1-16). */
export const PROD_ASSET_BASE = 'https://media.ebda.app/demo/qamar';
export const SOUQ_PROD_ASSET_BASE = 'https://media.ebda.app/demo/souq';

/**
 * One entry per demo template (Ruling B2-7). Everything a template's showroom differs in is here;
 * the catalogue writer (`seedCatalogue`) and the home publisher read ONLY this, never a slug.
 */
export const TEMPLATE_SPECS = {
  qamar: {
    template: 'qamar',
    slug: SLUG,
    ownerEmail: OWNER_EMAIL,
    name: 'Ebda Demo',
    nameAr: 'إبدا ديمو',
    defaultLook: DEFAULT_LOOK,
    categories: QAMAR_CATEGORIES,
    products: QAMAR_PRODUCTS,
    sizeCharts: QAMAR_SIZE_CHARTS,
    occasionSlugs: QAMAR_OCCASIONS.map(o => o.slug),
    archivePlaceholders: true,
    assetEnv: 'QAMAR_DEMO_ASSET_BASE',
    prodAssetBase: PROD_ASSET_BASE,
    localLookStores: LOCAL_LOOK_STORES,
    localStoreName: l => [`Qamar ${l.name.en}`, `قمر ${l.name.ar}`],
    buildHome: buildQamarHome,
    description:
      'An illustrative Egyptian boutique: abayas, kaftans, scarves and evening dresses, cut in Heliopolis.',
    descriptionAr: 'بوتيك مصري توضيحي: عبايات وقفاطين وطرح وفساتين سهرة، متفصلة في مصر الجديدة.',
    deliveryDays: { min: 2, max: 4 },
    instalments: null,
  },
  souq: {
    template: 'souq',
    slug: 'storedemo-souq',
    ownerEmail: 'storedemo-souq-owner@ebda.app',
    name: 'Ebda Souq Demo',
    nameAr: 'إبدا سوق ديمو',
    defaultLook: 'souq.catalogue',
    categories: SOUQ_CATEGORIES,
    products: SOUQ_PRODUCTS,
    sizeCharts: {},
    occasionSlugs: [],
    archivePlaceholders: false,
    assetEnv: 'SOUQ_DEMO_ASSET_BASE',
    prodAssetBase: SOUQ_PROD_ASSET_BASE,
    localLookStores: [
      ['souq-catalogue', 'souq.catalogue'],
      ['souq-night', 'souq.night'],
      ['souq-showroom', 'souq.showroom'],
    ],
    localStoreName: l => [`Souq ${l.name.en}`, `سوق ${l.name.ar}`],
    buildHome: buildSouqHome,
    description:
      'An illustrative Egyptian electronics and appliances shop: phones, laptops, audio, watches, screens and home appliances.',
    descriptionAr:
      'متجر مصري توضيحي للإلكترونيات والأجهزة المنزلية: موبايلات ولابتوب وصوتيات وساعات وشاشات وأجهزة.',
    deliveryDays: { min: 2, max: 4 },
    // Ruling B2-9: arithmetic only, 12 months, no markup, NO provider name.
    instalments: { enabled: true, months: 12, markupPct: 0 },
  },
};
/** `--template <name>` (default qamar); an unknown name is refused by the caller. */
export function templateFromArgv(argv) {
  const i = argv.indexOf('--template');
  const name = i === -1 ? 'qamar' : argv[i + 1];
  return TEMPLATE_SPECS[name] ?? null;
}

/** Where the demo photos are served from. Production: only the template's prod asset base. */
export function assetBase(argv, env, spec = TEMPLATE_SPECS.qamar) {
  const base = (env[spec.assetEnv] || spec.prodAssetBase).replace(/\/$/, '');
  if (argv.includes('--yes-production') && base !== spec.prodAssetBase)
    return {
      ok: false,
      why: `--yes-production needs the asset base ${spec.prodAssetBase}, got ${base}`,
    };
  return { ok: true, base };
}
/** The hero clip URL, or null when the base cannot carry one (a video must be https or relative). */
export function videoUrl(base) {
  const u = `${base}/hero.mp4`;
  return u.startsWith('https://') || u.startsWith('/') ? u : null;
}

const slugPart = s =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
/** Variant SKU from the FULL value slugs (C17): LINEN-ABAYA-ROSE-M-56, never initials. */
export const variantSku = (productSlug, values) =>
  [productSlug, ...values].map(slugPart).join('-').toUpperCase();
/** Every option-value combination, in option order. */
export const combos = options =>
  options.reduce((acc, o) => acc.flatMap(a => o.values.map(v => [...a, v])), [[]]);

/** The human-readable plan, printed before anything is written. */
export function describePlan(url, spec = TEMPLATE_SPECS.qamar) {
  const variants = spec.products.reduce(
    (n, p) => n + (p.options ? combos(p.options).length : 0),
    0
  );
  const charts = Object.keys(spec.sizeCharts).length;
  return [
    `target database host: ${hostOf(url) ?? '(unparseable DATABASE_URL)'}`,
    `store: slug "${spec.slug}", is_demo = true, look ${spec.defaultLook}, theme {} (owner ${spec.ownerEmail}, no login)`,
    `${spec.template}: ${spec.products.length} products, ${variants} variants, ${spec.categories.length} categories (${spec.categories.map(c => c.slug).join(', ')}), ${charts} size charts, 1 shipping zone${spec.instalments ? ', instalments enabled (no provider name)' : ''}`,
    ...(spec.archivePlaceholders
      ? [
          `archived: ${PLACEHOLDER_CATEGORY_SLUGS.join(', ')} (${PLACEHOLDER_SLUGS.length} placeholder products, status archived, never deleted)`,
        ]
      : []),
    `home: the ${spec.template === 'qamar' ? 'Qamar' : 'Souq'} superset document, saved + published through the page builder`,
    'idempotent: upsert owner/store/categories/products, find-then-update charts/zone/variants',
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The catalogue, size charts, shipping zone and settings for ONE store (owner client, one tx). */
export async function seedCatalogue(prisma, Prisma, storeId, base, spec = TEMPLATE_SPECS.qamar) {
  const url = f => `${base}/${f}`;
  return prisma.$transaction(
    async tx => {
      // Archive, never delete: Phase S placeholder products and their categories (B1-15, C3).
      // Qamar's showroom only: the Souq demo store never had them.
      const archived = spec.archivePlaceholders
        ? await tx.product.updateMany({
            where: { storeId, slug: { in: PLACEHOLDER_SLUGS }, status: { not: 'archived' } },
            data: { status: 'archived' },
          })
        : { count: 0 };
      if (spec.archivePlaceholders)
        await tx.category.updateMany({
          where: { storeId, slug: { in: PLACEHOLDER_CATEGORY_SLUGS } },
          data: { isActive: false },
        });

      // Size charts: no unique key, so find by (store, name) then update or create (C17).
      const chartIds = {};
      for (const [key, c] of Object.entries(spec.sizeCharts)) {
        const data = { ...c, columns: c.columns, rows: c.rows };
        const found = await tx.sizeChart.findFirst({
          where: { storeId, name: c.name },
          select: { id: true },
        });
        chartIds[key] = found
          ? (await tx.sizeChart.update({ where: { id: found.id, storeId }, data })).id
          : (await tx.sizeChart.create({ data: { storeId, ...data } })).id;
      }

      const catIds = new Map();
      for (const [position, c] of spec.categories.entries()) {
        const occasion = spec.occasionSlugs.includes(c.slug);
        const data = {
          name: c.name,
          nameAr: c.nameAr,
          position,
          isActive: true,
          // Occasion categories feed Vitrine's bands, not the home category row.
          showOnHomeStrip: !occasion,
          sizeChartId: c.sizeChart ? chartIds[c.sizeChart] : null,
          // A product photo already in the set: Lookbook's photo category row needs one (Task 7).
          image: c.image ? url(c.image) : null,
        };
        const cat = await tx.category.upsert({
          where: { storeId_slug: { storeId, slug: c.slug } },
          update: data,
          create: { storeId, slug: c.slug, ...data },
        });
        catIds.set(c.slug, cat.id);
      }

      const productIdBySlug = new Map();
      let variantCount = 0;
      // "New in" (`productSource: newest`) lists only products flagged `isNew`: flag the first
      // NEW_IN_COUNT products that have a photo (12 fills 2, 3 and 4 columns with no orphan row).
      const NEW_IN_COUNT = 12;
      // TODO(decisions-1016, Ruling B1-117): the card "New" badge becomes a merchant toggle there
      // (`theme.showNewBadge`, default OFF; `isProductNew` takes `theme`). That setting does not
      // exist on this branch, so `theme` stays {} here. When decisions-1016 merges, the showroom
      // seed MUST set `theme: { showNewBadge: true }` or every NEW chip on the showroom disappears.
      const newIn = new Set(
        spec.products
          .filter(p => p.images.length > 0)
          .slice(0, NEW_IN_COUNT)
          .map(p => p.slug)
      );
      for (const [i, p] of spec.products.entries()) {
        const hasVariants = Boolean(p.options?.length);
        const data = {
          name: p.name,
          nameAr: p.nameAr,
          description: p.description,
          descriptionAr: p.descriptionAr,
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? null,
          status: 'active',
          hasVariants,
          // Inventory model: a variant product's own inventory stays 0 (stock = active variants).
          inventory: hasVariants ? 0 : (p.stock ?? 25),
          allowBackorder: !hasVariants && p.backorder === true,
          featured: i < 4,
          isNew: newIn.has(p.slug),
          newArrivalPosition: i,
          facts: (p.facts ?? []).map(f => ({ ...f, onCard: f.onCard === true })),
          leadTimeDays: p.leadTimeDays ?? null,
          personalisation: p.personalisation
            ? { enabled: true, ...p.personalisation }
            : Prisma.DbNull,
        };
        const product = await tx.product.upsert({
          where: { storeId_slug: { storeId, slug: p.slug } },
          update: data,
          create: { storeId, slug: p.slug, ...data },
        });
        productIdBySlug.set(p.slug, product.id);

        // No FK points at product_images: replace the set.
        await tx.productImage.deleteMany({ where: { productId: product.id } });
        if (p.images.length)
          await tx.productImage.createMany({
            data: p.images.map((f, position) => ({
              productId: product.id,
              url: url(f),
              // The store is Arabic-first (defaultLanguage ar); the column is single-language.
              alt: p.nameAr || p.name,
              position,
            })),
          });

        for (const slug of [p.category, ...(p.alsoIn ?? [])]) {
          const categoryId = catIds.get(slug);
          await tx.productCategory.upsert({
            where: { productId_categoryId: { productId: product.id, categoryId } },
            update: { position: i },
            create: { productId: product.id, categoryId, position: i },
          });
        }

        if (!hasVariants) continue;
        // Options, values and variants are upserted, never deleted (cart lines may point at them).
        const valueIds = [];
        for (const [oPos, o] of p.options.entries()) {
          const option = await tx.productOption.upsert({
            where: { productId_name: { productId: product.id, name: o.name } },
            update: { nameAr: o.nameAr, position: oPos },
            create: { productId: product.id, name: o.name, nameAr: o.nameAr, position: oPos },
          });
          const ids = new Map();
          for (const [vPos, v] of o.values.entries()) {
            const swatch = {
              valueAr: v.valueAr,
              swatchHex: v.hex ?? null,
              swatchImageUrl: v.image ? url(v.image) : null,
              position: vPos,
            };
            const value = await tx.productOptionValue.upsert({
              where: { optionId_value: { optionId: option.id, value: v.value } },
              update: swatch,
              create: { optionId: option.id, value: v.value, ...swatch },
            });
            ids.set(v.value, value.id);
          }
          valueIds.push(ids);
        }
        const soldOut = new Set((p.soldOut ?? []).map(t => t.join('|')));
        const liveSkus = combos(p.options).map(c =>
          variantSku(
            p.slug,
            c.map(v => v.value)
          )
        );
        // A SKU that left the catalogue is deactivated, never deleted (cart lines may point at
        // it) and never left active with stock (review minor).
        await tx.productVariant.updateMany({
          where: { productId: product.id, sku: { notIn: liveSkus } },
          data: { isActive: false },
        });
        for (const [vPos, combo] of combos(p.options).entries()) {
          const values = combo.map(v => v.value);
          const sku = variantSku(p.slug, values);
          const step = combo.reduce((n, v) => n + (v.priceAdd ?? 0), 0);
          const vData = {
            title: values.join(' / '),
            titleAr: combo.map(v => v.valueAr).join(' / '),
            inventory: soldOut.has(values.join('|')) ? 0 : (p.stock ?? 8),
            allowBackorder: p.backorder === true,
            // A sale on a variant product lives on its variants: the PDP shows the strike only
            // when the picked variant carries both prices (product-pricing.ts); null clears it.
            // `priceAdd` on an option value is a price STEP (a bigger storage costs more): the
            // variant carries base + steps, and the same steps on the compare-at price.
            price: p.compareAtPrice || step ? p.price + step : null,
            compareAtPrice: p.compareAtPrice ? p.compareAtPrice + step : null,
            isActive: true,
            position: vPos,
          };
          const found = await tx.productVariant.findFirst({
            where: { productId: product.id, sku },
            select: { id: true },
          });
          const variant = found
            ? await tx.productVariant.update({ where: { id: found.id }, data: vData })
            : await tx.productVariant.create({ data: { productId: product.id, sku, ...vData } });
          await tx.productVariantOption.createMany({
            data: values.map((v, k) => ({ variantId: variant.id, valueId: valueIds[k].get(v) })),
            skipDuplicates: true,
          });
          variantCount++;
        }
      }

      // Shipping zone: no unique key, so find by (store, name) then update or create (C17).
      const zone = {
        name: 'Greater Cairo',
        nameAr: 'القاهرة الكبرى',
        areas: ['Cairo', 'Giza'],
        areasAr: ['القاهرة', 'الجيزة'],
        deliveryFee: 6000,
        estimatedDaysMin: 1,
        estimatedDaysMax: 3,
        isActive: true,
      };
      const z = await tx.shippingZone.findFirst({
        where: { storeId, name: zone.name },
        select: { id: true },
      });
      if (z) await tx.shippingZone.update({ where: { id: z.id, storeId }, data: zone });
      else await tx.shippingZone.create({ data: { storeId, ...zone } });

      // Cash on delivery + a 14-day return window: the shared PDP trust line (S-02) reads both
      // from the store, so every look is judged with the trust line it ships with (W2b).
      const cod = {
        provider: 'cod',
        isEnabled: true,
        displayName: 'Cash on delivery',
        displayNameAr: 'الدفع عند الاستلام',
      };
      const codRow = await tx.paymentConfig.findFirst({
        where: { storeId, provider: 'cod' },
        select: { id: true },
      });
      if (codRow) await tx.paymentConfig.update({ where: { id: codRow.id, storeId }, data: cod });
      else await tx.paymentConfig.create({ data: { storeId, ...cod } });

      // Store settings: read, spread, write (the store row is this seed's own).
      const store = await tx.store.findUnique({
        where: { id: storeId },
        select: { settings: true },
      });
      await tx.store.update({
        where: { id: storeId },
        data: {
          description: spec.description,
          descriptionAr: spec.descriptionAr,
          returnWindowDays: 14,
          // "Demo store" is said once, by the demo bar above it (DemoLookBar); this line only
          // labels the photos (Task 9 review).
          announcementBar: {
            enabled: true,
            text: 'Illustrative photos',
            textAr: 'الصور توضيحية',
          },
          settings: {
            ...((store?.settings && typeof store.settings === 'object' && store.settings) || {}),
            currency: 'EGP',
            locale: 'ar-EG',
            defaultLanguage: 'ar',
            deliveryDays: spec.deliveryDays,
            // Ruling B2-9: written only for a template that shows instalments; a re-seed of the
            // Qamar showroom leaves the key out, exactly as before.
            ...(spec.instalments ? { instalments: spec.instalments } : {}),
          },
        },
      });
      return { productIdBySlug, variantCount, archived: archived.count };
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
}

async function run() {
  const url = process.env.DATABASE_URL;
  const argv = process.argv.slice(2);
  const spec = templateFromArgv(argv);
  if (!spec) {
    console.error(
      `Unknown --template; expected one of: ${Object.keys(TEMPLATE_SPECS).join(', ')}.`
    );
    process.exit(2);
  }
  console.log(describePlan(url, spec));
  const g = guard(url, argv);
  if (!g.ok) {
    console.error(g.why);
    process.exit(2);
  }
  const a = assetBase(argv, process.env, spec);
  if (!a.ok) {
    console.error(a.why);
    process.exit(2);
  }
  const lookStores = argv.includes('--local-look-stores');
  if (lookStores && argv.includes('--yes-production')) {
    console.error(
      '--local-look-stores is a local review aid; it is refused with --yes-production.'
    );
    process.exit(2);
  }
  console.log(
    `assets: ${a.base}${lookStores ? '\nlocal look stores: ' + spec.localLookStores.map(s => s[0]).join(', ') : ''}`
  );
  process.env.DIRECT_URL ??= url;

  // API modules load here, never at import time (the unit test imports this file; C17).
  const { createPrismaClient, Prisma, runInStoreScope } = await import('@ebda/database');
  const { getLook } = await import('@ebda/shared');
  const { getPageState, saveDraft, publishDraft } = await import(
    `${root}/apps/api/src/services/page-builder.service.ts`
  );
  const { invalidateStoreProductCaches } = await import(`${root}/apps/api/src/lib/public-cache.ts`);
  const look = getLook(spec.defaultLook);
  if (!look) throw new Error(`default look ${spec.defaultLook} is not in the registry`);
  const video = videoUrl(a.base);
  if (!video) console.warn(`hero clip skipped: ${a.base} is neither https nor a relative path`);
  const img = f => `${a.base}/${f}`;

  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  const publishHome = async (storeId, ownerId, productIdBySlug) =>
    runInStoreScope(storeId, async () => {
      const state = await getPageState(storeId, 'home');
      const doc = spec.buildHome(state.definition, { img, video, productIdBySlug });
      const saved = await saveDraft({
        storeId,
        pageKey: 'home',
        baseRev: state.rev,
        definition: doc,
        userId: ownerId,
      });
      if (!saved.ok)
        throw new Error(`saveDraft: ${saved.message} ${JSON.stringify(saved.errors ?? [])}`);
      const pub = await publishDraft({ storeId, pageKey: 'home', baseRev: saved.value.rev });
      if (!pub.ok) throw new Error(`publishDraft: ${pub.message}`);
      return pub.value.rev;
    });
  try {
    const owner = await prisma.$transaction(
      async tx =>
        (await tx.user.findFirst({ where: { email: spec.ownerEmail, storeId: null } })) ??
        (await tx.user.create({
          data: {
            email: spec.ownerEmail,
            passwordHash: '!seed-no-login',
            firstName: 'Store',
            lastName: 'Demo',
            role: 'store_admin',
            emailVerified: true,
          },
        }))
    );
    const base = {
      name: spec.name,
      nameAr: spec.nameAr,
      template: look.skin,
      look: look.id,
      theme: {},
      isDemo: true,
      status: 'active',
      currency: 'EGP',
      // The showroom runs the Professional plan so every feature the catalogue shows is live
      // (the backorder pre-order is `inventory.backorder`, a Professional feature; Ruling B1-112).
      plan: 'professional',
    };
    const store = await prisma.store.upsert({
      where: { slug: spec.slug },
      update: base,
      create: { ...base, slug: spec.slug, ownerId: owner.id },
    });
    const seeded = await runInStoreScope(store.id, () =>
      seedCatalogue(prisma, Prisma, store.id, a.base, spec)
    );
    const rev = await publishHome(store.id, owner.id, seeded.productIdBySlug);
    await invalidateStoreProductCaches(store.id);
    console.log(
      `seeded ${spec.slug} (${store.id}): ${seeded.productIdBySlug.size} products, ${seeded.variantCount} variants, archived ${seeded.archived} placeholder products, home rev ${rev}`
    );

    if (lookStores) {
      const { StoreService } = await import(`${root}/apps/api/src/services/store.service.ts`);
      for (const [slug, lookId] of spec.localLookStores) {
        const l = getLook(lookId);
        // A NON-demo merchant store (local review only), created on the look's skin as onboarding
        // provisions a store for a chosen look; the look itself is applied below through the
        // merchant path (applyLook), so re-runs keep template/look.
        const s = await prisma.store.upsert({
          where: { slug },
          update: {
            name: spec.localStoreName(l)[0],
            nameAr: spec.localStoreName(l)[1],
            isDemo: false,
            status: 'active',
            plan: 'professional',
          },
          create: {
            slug,
            ownerId: owner.id,
            name: spec.localStoreName(l)[0],
            nameAr: spec.localStoreName(l)[1],
            template: l.skin,
            theme: {},
            isDemo: false,
            status: 'active',
            currency: 'EGP',
            plan: 'professional',
          },
        });
        const sSeeded = await runInStoreScope(s.id, () =>
          seedCatalogue(prisma, Prisma, s.id, a.base, spec)
        );
        await publishHome(s.id, owner.id, sSeeded.productIdBySlug);
        const applied = await runInStoreScope(s.id, async () => {
          const r = await StoreService.applyLook(s.id, lookId, { design: 'reset' }, owner.id);
          if (r.builder !== 'draft') return r.builder;
          // A store with content takes the draft path; publish it as the merchant would.
          const state = await getPageState(s.id, 'home');
          const pub = await publishDraft({ storeId: s.id, pageKey: 'home', baseRev: state.rev });
          if (!pub.ok) throw new Error(`publishDraft after applyLook: ${pub.message}`);
          return 'published';
        });
        await invalidateStoreProductCaches(s.id);
        console.log(`seeded ${slug} (${s.id}) on ${lookId}: home ${applied}`);
      }
    }
  } catch (err) {
    // Set the failure code HERE, before the forced exit below: an imported API module may install
    // an uncaughtException/unhandledRejection handler, so a rethrow alone could still end in 0.
    process.exitCode = 1;
    console.error('seed failed:', err);
  } finally {
    await prisma.$disconnect().catch(() => {});
    // The API modules leave a Redis client and timers open; this is a one-shot script.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run().catch(err => {
    // A throw before the main try (imports, client creation) must fail the command too.
    console.error('seed failed:', err);
    process.exit(1);
  });
}
