#!/usr/bin/env node
// Seed a looks DEMO store (is_demo = true): the showroom that previews every built look of its
// template through `?look=<id>` (apps/web/src/lib/demo-look.ts) and refuses every order. One demo
// store per template (Ruling B2-7): `storedemo` = Qamar (default), `storedemo-souq` = Souq
// (`--template souq`, SOUQ_DEMO_ASSET_BASE, prod asset base https://media.ebda.app/demo/souq),
// `storedemo-jasmine` = Jasmine (`--template jasmine`, JASMINE_DEMO_ASSET_BASE, prod asset base
// https://media.ebda.app/demo/jasmine; Ruling B3-8), `storedemo-lamma` = Lamma (`--template lamma`,
// LAMMA_DEMO_ASSET_BASE, prod asset base https://media.ebda.app/demo/lamma; Ruling B4-10),
// `storedemo-dahab` = Dahab (`--template dahab`, DAHAB_DEMO_ASSET_BASE, prod asset base
// https://media.ebda.app/demo/dahab; Ruling B5-10), which also turns gold-rate pricing on and prices its
// six gold pieces from a manual rate through GoldRateService.
//
//   DATABASE_URL=<owner-role postgres url> [QAMAR_DEMO_ASSET_BASE=<url or /path>] \
//     npx tsx scripts/storedemo/seed.mjs [--template qamar|souq|jasmine|lamma|dahab] [--yes-production] [--local-look-stores]
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
// The store's theme is SHOWROOM_THEME on purpose (one merchant toggle, NEW chips on): the demo
// preview composes skin + look with no other merchant overrides, and a showroom must show the look.
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
import {
  JASMINE_CATEGORIES,
  JASMINE_PRODUCTS,
  JASMINE_TAGS,
  JASMINE_BUNDLES,
  JASMINE_REVIEWS,
} from '../jasmine-demo/catalogue.mjs';
import { LAMMA_CATEGORIES, LAMMA_PRODUCTS } from '../lamma-demo/catalogue.mjs';
import { buildSouqHome } from './souq-home.mjs';
import { buildJasmineHome } from './jasmine-home.mjs';
import { buildLammaHome } from './lamma-home.mjs';
import {
  DAHAB_CATEGORIES,
  DAHAB_GOLD_RATES,
  DAHAB_OCCASIONS,
  DAHAB_PRODUCTS,
  DAHAB_SIZE_CHARTS,
} from '../dahab-demo/catalogue.mjs';
import { buildDahabHome } from './dahab-home.mjs';

export { buildQamarHome, buildSouqHome, buildJasmineHome, buildLammaHome, buildDahabHome };

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

/** The only theme key a showroom store sets: the merchant's NEW-chip toggle, ON (see seedCatalogue). */
export const SHOWROOM_THEME = { showNewBadge: true };

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
export const JASMINE_PROD_ASSET_BASE = 'https://media.ebda.app/demo/jasmine';
export const LAMMA_PROD_ASSET_BASE = 'https://media.ebda.app/demo/lamma';
export const DAHAB_PROD_ASSET_BASE = 'https://media.ebda.app/demo/dahab';

/** Approved, verified reviews for the Dahab showroom (the Worn look's reviews row): [slug, rating, body, language]. */
export const DAHAB_REVIEWS = [
  ['gold-chain-21', 5, 'خفيفة وشكلها شيك، والعيار مكتوب بوضوح وجه زي ما اتوصف.', 'ar'],
  ['pearl-necklace', 5, 'اللؤلؤ لونه هادي ومتناسق، والقفل متين. اتغلفت في علبة حلوة.', 'ar'],
  ['engraved-ring', 4, 'الحفر طلع نضيف والحروف واضحة. خدت 5 أيام زي ما اتقال.', 'ar'],
  [
    'pearl-studs',
    5,
    'Small, even pearls and a clean post. Arrived in a gift box with my card.',
    'en',
  ],
  [
    'heart-pendant',
    5,
    'هدية لأمي في عيد الأم، فرحت بيها جدًا والرسالة على الكارت كانت لطيفة.',
    'ar',
  ],
  ['silver-band-ring', 4, 'Comfortable band, the size chart was right for me.', 'en'],
];

/**
 * One entry per demo template (Ruling B2-7). Everything a template's showroom differs in is here;
 * the catalogue writer (`seedCatalogue`) and the home publisher read ONLY this, never a slug.
 */
export const TEMPLATE_SPECS = {
  qamar: {
    template: 'qamar',
    slug: SLUG,
    ownerEmail: OWNER_EMAIL,
    name: 'Qamar',
    nameAr: 'قمر',
    defaultLook: DEFAULT_LOOK,
    categories: QAMAR_CATEGORIES,
    products: QAMAR_PRODUCTS,
    sizeCharts: QAMAR_SIZE_CHARTS,
    occasionSlugs: QAMAR_OCCASIONS.map(o => o.slug),
    archivePlaceholders: true,
    retiredSlugs: ['modal-scarf-no-image'],
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
    name: 'Souq',
    nameAr: 'سوق',
    defaultLook: 'souq.catalogue',
    categories: SOUQ_CATEGORIES,
    products: SOUQ_PRODUCTS,
    sizeCharts: {},
    occasionSlugs: [],
    archivePlaceholders: false,
    retiredSlugs: ['phone-case-set'],
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
  jasmine: {
    template: 'jasmine',
    slug: 'storedemo-jasmine',
    // Ruling B3-8: no mailbox behind this address, no login (`passwordHash '!seed-no-login'`).
    ownerEmail: 'storedemo-jasmine-owner@ebda.app',
    name: 'Jasmine',
    nameAr: 'ياسمين',
    defaultLook: 'jasmine.clinic',
    categories: JASMINE_CATEGORIES,
    products: JASMINE_PRODUCTS,
    sizeCharts: {},
    occasionSlugs: [],
    archivePlaceholders: false,
    retiredSlugs: ['makeup-brush-set'],
    assetEnv: 'JASMINE_DEMO_ASSET_BASE',
    prodAssetBase: JASMINE_PROD_ASSET_BASE,
    localLookStores: [
      ['jasmine-apothecary', 'jasmine.apothecary'],
      ['jasmine-bloom', 'jasmine.bloom'],
      ['jasmine-clinic', 'jasmine.clinic'],
    ],
    localStoreName: l => [`Jasmine ${l.name.en}`, `ياسمين ${l.name.ar}`],
    buildHome: buildJasmineHome,
    description:
      'An illustrative Egyptian beauty and skincare shop: cleansers, serums, moisturisers, makeup, perfumes and hair care.',
    descriptionAr:
      'متجر مصري توضيحي للعناية بالبشرة والجمال: غسول وسيرومات ومرطبات ومكياج وعطور وعناية بالشعر.',
    deliveryDays: { min: 2, max: 4 },
    // Ruling B2-9 (reused): arithmetic only, no provider name.
    instalments: { enabled: true, months: 12, markupPct: 0 },
    // Ruling B3-5/B3-6: the skin-type chips, the real routine bundle, approved reviews, and the
    // `bundles` feature (in no plan baseline: a StoreFeature override, like every bundle store).
    tags: JASMINE_TAGS,
    bundles: JASMINE_BUNDLES,
    reviews: JASMINE_REVIEWS,
    features: ['bundles'],
  },
  lamma: {
    template: 'lamma',
    slug: 'storedemo-lamma',
    // Ruling B4-10: no mailbox behind this address, no login (`passwordHash '!seed-no-login'`).
    ownerEmail: 'storedemo-lamma-owner@ebda.app',
    name: 'Lamma',
    nameAr: 'لمّة',
    defaultLook: 'lamma.table',
    categories: LAMMA_CATEGORIES,
    products: LAMMA_PRODUCTS,
    sizeCharts: {},
    occasionSlugs: [],
    archivePlaceholders: false,
    assetEnv: 'LAMMA_DEMO_ASSET_BASE',
    prodAssetBase: LAMMA_PROD_ASSET_BASE,
    localLookStores: [
      ['lamma-table', 'lamma.table'],
      ['lamma-notebook', 'lamma.notebook'],
      ['lamma-market', 'lamma.market'],
    ],
    localStoreName: l => [`Lamma ${l.name.en}`, `لمّة ${l.name.ar}`],
    buildHome: buildLammaHome,
    description:
      'An illustrative Egyptian home kitchen and grocery: stuffed vegetables, tagines, grill and sweets, plus fresh produce, dairy and pantry basics.',
    descriptionAr:
      'مطبخ بيتي وبقالة مصرية توضيحية: محاشي وطواجن ومشويات وحلويات، وخضار وفاكهة وألبان وبقالة.',
    // Food delivers the same day (estimate 0 business days), every day of the week (Ruling B4-7).
    deliveryDays: { min: 0, max: 1 },
    instalments: null,
    // Ruling B4-12: the delivery time is merchant text in the announcement bar, never a platform promise.
    announcement: {
      text: 'Delivery within 45 minutes (demo store)',
      textAr: 'التوصيل خلال 45 دقيقة (ده متجر تجريبي)',
    },
    // Store settings a food shop needs: a 150 EGP minimum order (piastres), delivery every day,
    // the date chips 5 days ahead with two windows (lunch and dinner, each with its cut-off).
    storeSettings: {
      minimumOrderFils: 15_000,
      deliveryOffDays: [],
      checkoutDelivery: {
        note: { enabled: false, text: '', textAr: '' },
        windows: {
          enabled: true,
          items: [
            {
              id: 'lunch',
              label: 'Lunch 12-2',
              labelAr: 'غدا 12-2',
              start: '12:00',
              end: '14:00',
              orderBy: '10:00',
            },
            {
              id: 'dinner',
              label: 'Dinner 6-8',
              labelAr: 'عشا 6-8',
              start: '18:00',
              end: '20:00',
              orderBy: '15:00',
            },
          ],
        },
        daysAhead: 5,
      },
    },
    zone: { deliveryFee: 3_500, estimatedDaysMin: 0, estimatedDaysMax: 1 },
  },
  dahab: {
    template: 'dahab',
    slug: 'storedemo-dahab',
    // Ruling B5-10: no mailbox behind this address, no login (`passwordHash '!seed-no-login'`).
    ownerEmail: 'storedemo-dahab-owner@ebda.app',
    name: 'Dahab',
    nameAr: 'دهب',
    defaultLook: 'dahab.worn',
    categories: DAHAB_CATEGORIES,
    products: DAHAB_PRODUCTS,
    sizeCharts: DAHAB_SIZE_CHARTS,
    occasionSlugs: DAHAB_OCCASIONS.map(o => o.slug),
    archivePlaceholders: false,
    assetEnv: 'DAHAB_DEMO_ASSET_BASE',
    prodAssetBase: DAHAB_PROD_ASSET_BASE,
    localLookStores: [
      ['dahab-worn', 'dahab.worn'],
      ['dahab-workshop', 'dahab.workshop'],
      ['dahab-giftbox', 'dahab.giftbox'],
    ],
    localStoreName: l => [`Dahab ${l.name.en}`, `دهب ${l.name.ar}`],
    buildHome: buildDahabHome,
    description:
      'An illustrative Egyptian jewellery shop: rings, necklaces, bracelets and earrings, plus gold pieces priced from the day\u2019s gold rate.',
    descriptionAr:
      'محل مجوهرات مصري توضيحي: خواتم وسلاسل وأساور وحلقان، وقطع دهب بتتسعّر من سعر الدهب النهارده.',
    deliveryDays: { min: 2, max: 4 },
    instalments: null,
    reviews: DAHAB_REVIEWS,
    // Phase B5 (Rulings B5-12, B5-15, DEMO-GOLD-1): the seed still re-stamps a MANUAL rate on every run so a
    // fresh seed is never stale, but the production Dahab demo runs on the AUTOMATIC gold rate (feed: true,
    // Ahmad 2026-10-23): a manual rate goes stale after 26 hours and would pause gold selling.
    gold: { rates: DAHAB_GOLD_RATES, showBreakdown: true, feed: true },
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
    ...(spec.tags?.length
      ? [
          `jasmine-style extras: ${spec.tags.length} skin-type / concern tags, ${spec.bundles?.length ?? 0} routine bundle(s), ${spec.reviews?.length ?? 0} approved reviews, features ${(spec.features ?? []).join(', ') || 'none'}`,
        ]
      : []),
    ...(spec.gold
      ? [
          `gold pricing: ${spec.products.filter(p => p.gold).length} gold-rate products, rates ${spec.gold.rates.map(r => `${r.karat}k=${r.ratePerGram / 100}`).join(' / ')} EGP per gram (manual, re-stamped every run), automatic rate ${spec.gold.feed ? 'ON' : 'off'}`,
        ]
      : []),
    ...(spec.storeSettings
      ? [
          `store settings: ${Object.keys(spec.storeSettings).join(', ')} (minimum order, delivery calendar, date chips)`,
        ]
      : []),
    ...(spec.archivePlaceholders
      ? [
          `archived: ${PLACEHOLDER_CATEGORY_SLUGS.join(', ')} (${PLACEHOLDER_SLUGS.length} placeholder products, status archived, never deleted)`,
        ]
      : []),
    `home: the ${spec.template[0].toUpperCase()}${spec.template.slice(1)} superset document, saved + published through the page builder`,
    'idempotent: upsert owner/store/categories/products, find-then-update charts/zone/variants',
  ].join('\n');
}

/**
 * Slug ownership (Ruling B2-17, security review): the seed must never take over a store it did
 * not create. `existing` is the store row already holding the slug (or null); `owner` the seed
 * owner row (or null when it does not exist yet); `demo` whether this slug is a demo store
 * (`storedemo*`) or a local review store. A store that is not the seed's own, whatever its
 * flags, is refused: a merchant who registered the slug first keeps their store and the run
 * aborts. Pure, so it is unit-tested.
 */
export function seedStoreClaim(existing, owner, { demo }) {
  if (!existing) return { ok: true };
  if (existing.isDemo !== demo)
    return {
      ok: false,
      why: demo
        ? 'it is not a demo store (a merchant store already holds this slug)'
        : 'it is a demo store, not a local review store',
    };
  if (!owner || existing.ownerId !== owner.id)
    return { ok: false, why: 'its owner is not the seed owner (someone else registered the slug)' };
  return { ok: true };
}

/**
 * Check EVERY slug the run will write BEFORE the first write (no partial seed): the demo store's
 * slug and, with --local-look-stores, each local store's. Throws with the slug and the reason.
 */
export async function assertSlugsClaimable(prisma, spec, { localStores }) {
  const owner = await prisma.user.findFirst({
    where: { email: spec.ownerEmail, storeId: null },
    select: { id: true },
  });
  const slugs = [
    [spec.slug, true],
    ...(localStores ? spec.localLookStores.map(([slug]) => [slug, false]) : []),
  ];
  for (const [slug, demo] of slugs) {
    const existing = await prisma.store.findUnique({
      where: { slug },
      select: { id: true, isDemo: true, ownerId: true },
    });
    const claim = seedStoreClaim(existing, owner, { demo });
    if (!claim.ok)
      throw new Error(
        `refusing to touch store "${slug}": ${claim.why}. Nothing was written; resolve it by hand (never overwrite a merchant store).`
      );
  }
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

/**
 * The slugs flagged `isNew` ("New in" lists only these): the first `count` products that have a photo.
 * Lamma's Family table look renders its whole menu from that list under one tab per category, so
 * for Lamma the pick leads with one dish per category (a menu limited to the first 12 products
 * showed 4 of 8 tabs) and fills the rest in catalogue order.
 */
export function pickNewIn(spec, count) {
  const photo = spec.products.filter(p => p.images.length > 0);
  const picked = [];
  if (spec.template === 'lamma') {
    const seen = new Set();
    for (const p of photo)
      if (!seen.has(p.category)) {
        seen.add(p.category);
        picked.push(p);
      }
  }
  for (const p of photo) if (picked.length < count && !picked.includes(p)) picked.push(p);
  return new Set(picked.slice(0, count).map(p => p.slug));
}

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

      // DQ-1 (2026-10-23): a showroom never shows a no-photo product (the no-photo case lives in the
      // *-noimg scenario stores). Products dropped from a catalogue are ARCHIVED here, never deleted
      // (cart lines may point at them), so a re-seed of an old showroom retires them.
      if (spec.retiredSlugs?.length)
        await tx.product.updateMany({
          where: { storeId, slug: { in: spec.retiredSlugs }, status: { not: 'archived' } },
          data: { status: 'archived' },
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
      // Ruling B1-117 (decisions-1016, on main): the card "New" badge is a merchant toggle
      // (`theme.showNewBadge`, default OFF), so both showrooms and the local look stores seed it ON
      // (`SHOWROOM_THEME`); with `theme: {}` every NEW chip would disappear (STOP-2 final review).
      const newIn = pickNewIn(spec, NEW_IN_COUNT);
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
        // A gold-rate row's price belongs to the repricer (Ruling B5-13): on a re-seed the product is
        // updated WITHOUT price / compare-at (the DB trigger would refuse them), and it is created as a
        // fixed row with a placeholder that `seedGold` replaces through the service.
        const { price: _price, compareAtPrice: _compare, ...dataNoPrice } = data;
        const product = await tx.product.upsert({
          where: { storeId_slug: { storeId, slug: p.slug } },
          update: p.gold ? dataNoPrice : data,
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

        // Skin-type / concern tags (Ruling B3-5): the product's tag set is REPLACED (a child
        // table with no FK pointing at it), the tag rows are upserted per store.
        if (spec.tags?.length) {
          await tx.productTag.deleteMany({ where: { productId: product.id } });
          for (const name of p.tags ?? []) {
            const nameAr = spec.tags.find(x => x.name === name)?.nameAr ?? null;
            const tag = await tx.tag.upsert({
              where: { storeId_name: { storeId, name } },
              update: { nameAr },
              create: { storeId, name, nameAr },
            });
            await tx.productTag.create({ data: { productId: product.id, tagId: tag.id } });
          }
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
          // A variant of a gold-rate product carries the repricer's price (or inherits): never written here.
          if (p.gold) {
            delete vData.price;
            delete vData.compareAtPrice;
          }
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

      // Features a template's showroom needs that no plan baseline carries (the `bundles`
      // override, Ruling B3-6): upserted ON, never turned off by a re-seed.
      for (const featureKey of spec.features ?? []) {
        await tx.storeFeature.upsert({
          where: { storeId_featureKey: { storeId, featureKey } },
          update: { enabled: true },
          create: { storeId, featureKey, enabled: true },
        });
      }

      // The real routine bundle(s): upserted by slug, components replaced (variant-less only).
      // `percentage` is basis points over the CURRENT component prices, so the saving stays real
      // when a price changes (the PDP line and "add all" read it live).
      for (const b of spec.bundles ?? []) {
        const data = {
          name: b.name,
          nameAr: b.nameAr,
          description: b.description,
          descriptionAr: b.descriptionAr,
          pricingType: b.pricingType,
          pricingValue: b.pricingValue,
          isActive: true,
        };
        const bundle = await tx.bundle.upsert({
          where: { storeId_slug: { storeId, slug: b.slug } },
          update: data,
          create: { storeId, slug: b.slug, ...data },
        });
        await tx.bundleItem.deleteMany({ where: { bundleId: bundle.id } });
        await tx.bundleItem.createMany({
          data: b.products.map(slug => {
            const productId = productIdBySlug.get(slug);
            if (!productId) throw new Error(`bundle ${b.slug}: ${slug} is not in the catalogue`);
            return { bundleId: bundle.id, productId, variantId: null, quantity: 1 };
          }),
        });
      }

      // Approved, verified reviews (the PDP rating line). A review needs an order (RESTRICT FK):
      // one fixture order per review, found by its number so a re-seed never duplicates, with no
      // customer and a placeholder address (no PII).
      const addr = {
        firstName: 'Demo',
        lastName: 'Buyer',
        city: 'Cairo',
        country: 'EG',
        address1: 'Demo',
      };
      for (const [i, [slug, rating, body, language]] of (spec.reviews ?? []).entries()) {
        const productId = productIdBySlug.get(slug);
        if (!productId) throw new Error(`review ${i}: ${slug} is not in the catalogue`);
        // Order numbers are globally unique: keyed on the STORE id (the local look stores seed the
        // same spec), so two stores never share one.
        const orderNumber = `DEMO-${storeId.slice(0, 8)}-R${String(i + 1).padStart(3, '0')}`;
        const order =
          (await tx.order.findUnique({
            where: { orderNumber },
            select: { id: true, storeId: true },
          })) ??
          (await tx.order.create({
            data: {
              storeId,
              orderNumber,
              subtotal: 0,
              total: 0,
              status: 'delivered',
              shippingAddress: addr,
              billingAddress: addr,
            },
            select: { id: true, storeId: true },
          }));
        if (order.storeId !== storeId)
          throw new Error(`order ${orderNumber} belongs to another store`);
        const data = {
          storeId,
          rating,
          body,
          language,
          status: 'published',
          verifiedPurchase: true,
        };
        await tx.review.upsert({
          where: { orderId_productId: { orderId: order.id, productId } },
          update: data,
          create: { productId, orderId: order.id, ...data },
        });
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
        ...(spec.zone ?? {}),
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
            text: spec.announcement?.text ?? 'Illustrative photos',
            textAr: spec.announcement?.textAr ?? 'الصور توضيحية',
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
            // Ruling B4-7: minimum order, delivery calendar and date chips (Lamma only).
            ...(spec.storeSettings ?? {}),
          },
        },
      });
      return { productIdBySlug, variantCount, archived: archived.count };
    },
    { timeout: 900_000, maxWait: 10_000 }
  );
}

/**
 * Gold-rate pricing for a showroom (Phase B5): turn it on, stamp today's MANUAL rates, then write each gold
 * product's spec (and its variants' weights) through GoldRateService, the real merchant path, so the
 * repricer computes every price and the caches are purged. Runs AFTER `seedCatalogue` has committed: the
 * service opens its own money transaction. Idempotent: the same rates and specs reprice to the same prices
 * (confirm: true because a re-seed with changed demo rates is a deliberate jump).
 */
/**
 * Rates to stamp for a gold showroom: the same free feed the cron uses (karats 24/21/18 from one exact
 * quote, zero premium) so the first automatic run is not a jump; the spec's constants when the feed is down,
 * disagrees, or throws. `feed` = { goldFeed, storeCandidateRates } from the API's feed module (injected so
 * the unit test needs no network). Returns { rates, source: 'feed' | 'fallback' }.
 */
export async function marketGoldRates(fallbackRates, feed) {
  try {
    const res = await feed.goldFeed().fetch(AbortSignal.timeout(8000));
    if (res.kind !== 'ok') return { rates: fallbackRates, source: 'fallback' };
    const cand = feed.storeCandidateRates(res.quote, 0);
    const rates = fallbackRates.map(r => ({ karat: r.karat, ratePerGram: cand.get(r.karat) }));
    if (rates.some(r => !Number.isSafeInteger(r.ratePerGram) || r.ratePerGram <= 0))
      return { rates: fallbackRates, source: 'fallback' };
    return { rates, source: 'feed' };
  } catch {
    return { rates: fallbackRates, source: 'fallback' };
  }
}

export async function seedGold(prisma, storeId, userId, spec, productIdBySlug, GoldRateService) {
  const gold = spec.gold;
  const actor = { userId };
  await GoldRateService.updateSettings(
    storeId,
    {
      enabled: true,
      feedEnabled: gold.feed === true,
      feedPremiumBps: 0,
      maxAgeMinutes: 1560,
      jumpConfirmBps: 500,
      roundingStep: 1000,
      showBreakdown: gold.showBreakdown === true,
    },
    actor
  );
  await GoldRateService.applyRates(
    storeId,
    { rates: gold.rates.map(r => ({ karat: r.karat, ratePerGram: r.ratePerGram })), confirm: true },
    actor
  );
  let repriced = 0;
  for (const p of spec.products.filter(x => x.gold)) {
    const productId = productIdBySlug.get(p.slug);
    if (!productId) throw new Error(`gold product ${p.slug} was not seeded`);
    // A variant's own weight comes from the option value that names it (the ring's sizes weigh differently).
    const variants = [];
    if (p.options?.length) {
      const rows = await prisma.productVariant.findMany({
        where: { productId, isActive: true },
        select: { id: true, sku: true },
      });
      for (const combo of combos(p.options)) {
        const sku = variantSku(
          p.slug,
          combo.map(v => v.value)
        );
        const row = rows.find(r => r.sku === sku);
        if (!row) throw new Error(`gold product ${p.slug}: variant ${sku} is missing`);
        const weightMg = combo.map(v => v.weightMg).find(w => w != null) ?? null;
        variants.push({ id: row.id, pricingMode: null, weightMg });
      }
    }
    await GoldRateService.setProductPricing(
      storeId,
      productId,
      {
        product: {
          pricingMode: 'gold_rate',
          karat: p.gold.karat,
          weightMg: p.gold.weightMg,
          makingChargeType: p.gold.makingChargeType,
          makingChargeValue: p.gold.makingChargeValue,
          marginBps: p.gold.marginBps,
        },
        ...(variants.length ? { variants } : {}),
      },
      actor
    );
    repriced++;
  }
  return { repriced };
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
  const { GoldRateService } = await import(
    `${root}/apps/api/src/services/gold-rate/gold-rate.service.ts`
  );
  const feedAdapter = await import(`${root}/apps/api/src/services/gold-rate/feed/adapter.ts`);
  const look = getLook(spec.defaultLook);
  if (!look) throw new Error(`default look ${spec.defaultLook} is not in the registry`);
  const video = videoUrl(a.base);
  if (!video) console.warn(`hero clip skipped: ${a.base} is neither https nor a relative path`);
  const img = f => `${a.base}/${f}`;

  const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
  // Open the first pooled connection before any transaction: over the internet a Neon connect takes
  // longer than Prisma's default 2 s transaction maxWait (P2028 on the first `$transaction`).
  await prisma.$queryRaw`select 1`;
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
    await assertSlugsClaimable(prisma, spec, { localStores: lookStores });
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
      theme: SHOWROOM_THEME,
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
    let goldSpec = spec;
    if (spec.gold) {
      const m = await marketGoldRates(spec.gold.rates, feedAdapter);
      console.log(
        `gold rates stamped from ${m.source}: ${m.rates.map(r => `${r.karat}k=${r.ratePerGram / 100}`).join(' / ')} EGP/g`
      );
      goldSpec = { ...spec, gold: { ...spec.gold, rates: m.rates } };
    }
    const goldSeeded = spec.gold
      ? await runInStoreScope(store.id, () =>
          seedGold(prisma, store.id, owner.id, goldSpec, seeded.productIdBySlug, GoldRateService)
        )
      : null;
    const rev = await publishHome(store.id, owner.id, seeded.productIdBySlug);
    await invalidateStoreProductCaches(store.id);
    console.log(
      `seeded ${spec.slug} (${store.id}): ${seeded.productIdBySlug.size} products, ${seeded.variantCount} variants, archived ${seeded.archived} placeholder products, home rev ${rev}${goldSeeded ? `, ${goldSeeded.repriced} gold-rate products priced` : ''}`
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
            theme: SHOWROOM_THEME,
            isDemo: false,
            status: 'active',
            currency: 'EGP',
            plan: 'professional',
          },
        });
        const sSeeded = await runInStoreScope(s.id, () =>
          seedCatalogue(prisma, Prisma, s.id, a.base, spec)
        );
        if (spec.gold)
          await runInStoreScope(s.id, () =>
            seedGold(prisma, s.id, owner.id, spec, sSeeded.productIdBySlug, GoldRateService)
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
