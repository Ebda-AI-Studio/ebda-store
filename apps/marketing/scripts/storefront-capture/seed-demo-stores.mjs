// Seeds the five EXAMPLE stores (one per template family) into a LOCAL, throw-away Postgres
// so the real apps/web storefront can render them for the marketing captures. Never point
// this at Neon or production: it refuses any host that is not 127.0.0.1/localhost.
//
//   CAPTURE_ROOT=<ebda checkout with builder phase 2> OWNER_URL=<local owner connection string> \
//   node seed-demo-stores.mjs
// Photo URLs point at https://cdn.ebda.app/capture-demo/*, which capture.mjs serves from the
// local prepare-images.mjs output (nothing is uploaded anywhere).
//
// Each store gets: theme + legacy skin (merchant config), categories, products with the licensed
// photos and EGP prices from src/lib/demo-stores.ts, and a PUBLISHED builder document made the
// same way the builder's template picker does it (applyTemplateFamily) and written the same way
// publish writes it (store_page_revisions row + stores.layout_settings = definitionToLayout).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CAPTURE_ROOT;
const OWNER_URL = process.env.OWNER_URL;
const IMG = process.env.IMG_BASE || 'https://cdn.ebda.app/capture-demo';
if (!ROOT || !OWNER_URL) throw new Error('set CAPTURE_ROOT and OWNER_URL');
const host = new URL(OWNER_URL).hostname;
if (!['127.0.0.1', 'localhost'].includes(host))
  throw new Error(`refusing non-local database host ${host}`);

const req = createRequire(path.join(ROOT, 'packages', 'database', 'package.json'));
const { PrismaClient } = req('@prisma/client');
const { PrismaPg } = req('@prisma/adapter-pg');
const shared = createRequire(path.join(ROOT, 'package.json'))(
  path.join(ROOT, 'packages/shared/dist/index.js')
);
const { DEMO_STORES, TEMPLATE_IDS } = await import(
  path.join(here, '..', '..', 'src', 'lib', 'demo-stores.ts')
);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });

/** Merchant theme per example store (HSL strings, the StoreTheme format) + legacy skin. */
const LOOK = {
  souq: {
    template: 'modern',
    primary: '221 75% 48%',
    bg: '0 0% 100%',
    fg: '220 25% 10%',
    muted: '216 33% 96%',
    radius: 'md',
  },
  dahab: {
    template: 'elegant',
    primary: '38 48% 58%',
    bg: '40 12% 6%',
    fg: '40 45% 90%',
    muted: '40 12% 12%',
    radius: 'none',
  },
  qamar: {
    template: 'minimal',
    primary: '14 60% 41%',
    bg: '36 38% 95%',
    fg: '20 18% 14%',
    muted: '33 32% 87%',
    radius: 'none',
  },
  lamma: {
    template: 'bold',
    primary: '21 90% 40%',
    bg: '39 100% 94%',
    fg: '24 56% 15%',
    muted: '40 100% 77%',
    radius: 'lg',
  },
  jasmine: {
    template: 'classic',
    primary: '345 43% 46%',
    bg: '352 60% 97%',
    fg: '349 19% 20%',
    muted: '350 45% 91%',
    radius: 'lg',
  },
};

const CATEGORIES = {
  souq: [
    ['Audio', 'صوتيات', 'souq-headphones'],
    ['Wearables', 'ساعات', 'souq-watch'],
    ['Speakers', 'سبيكرات', 'souq-speaker'],
  ],
  dahab: [
    ['Rings', 'خواتم', 'dahab-solitaire'],
    ['Bracelets', 'غوايش', 'dahab-bangle'],
    ['Chains', 'سلاسل', 'dahab-chain'],
  ],
  qamar: [
    ['Dresses', 'فساتين', 'qamar-dress'],
    ['Shirts', 'قمصان', 'qamar-shirt'],
    ['Bags and shoes', 'شنط وجزم', 'qamar-bag'],
  ],
  lamma: [
    ['Cooked food', 'طبيخ', 'lamma-mahshi'],
    ['Sweets', 'حلويات', 'lamma-kahk'],
    ['Pickles', 'مخللات', 'lamma-torshi'],
  ],
  jasmine: [
    ['Skincare', 'عناية بالبشرة', 'jasmine-serum'],
    ['Soap', 'صابون', 'jasmine-soap'],
    ['Sets', 'أطقم', 'jasmine-soaps'],
  ],
};

const ANNOUNCE = {
  souq: ['Free delivery in Cairo over EGP 1,000', 'توصيل مجاني في القاهرة فوق 1,000 ج.م'],
  dahab: ['Free gift wrapping on every order', 'تغليف هدية ببلاش مع كل طلب'],
  qamar: ['New summer collection', 'كولكشن الصيف الجديد وصل'],
  lamma: ['Orders before 2 pm arrive today', 'اطلب قبل 2 الضهر يوصلك النهاردة'],
  jasmine: ['Natural ingredients, no parabens', 'مكونات طبيعية ومن غير بارابين'],
};

/** Hero photo per store: a darker frame so the template's white headline stays readable. */
const HERO_IMG = {
  souq: 'souq-watch',
  dahab: 'dahab-chain',
  qamar: 'qamar-dress',
  lamma: 'lamma-mahshi',
  jasmine: 'jasmine-hero',
};

const IMAGE_TEXT = {
  souq: ['Genuine, with warranty', 'أصلي وبضمان'],
  dahab: ['Handmade in 21-karat gold', 'شغل إيد من دهب عيار 21'],
  qamar: ['The summer collection', 'كولكشن الصيف'],
  lamma: ['Cooked at home, every day', 'متطبخ في البيت كل يوم'],
  jasmine: ['Made with natural ingredients', 'معمول من مكونات طبيعية'],
};

function theme(id) {
  const l = LOOK[id];
  const dark = id === 'dahab';
  return {
    ...shared.getTemplateTheme(l.template),
    primaryColor: l.primary,
    primaryForeground: dark ? '40 12% 6%' : '0 0% 100%',
    backgroundColor: l.bg,
    foregroundColor: l.fg,
    cardColor: l.bg,
    cardForeground: l.fg,
    popoverColor: l.bg,
    popoverForeground: l.fg,
    mutedColor: l.muted,
    mutedForeground: dark ? '40 15% 65%' : '220 9% 40%',
    secondaryColor: l.muted,
    secondaryForeground: l.fg,
    accentColor: l.muted,
    accentForeground: l.fg,
    borderColor: dark ? '40 12% 18%' : '220 13% 88%',
    inputColor: dark ? '40 12% 18%' : '220 13% 88%',
    borderRadius: l.radius,
    // Western digits on the Arabic storefront too (the template preset opts into Eastern ones).
    arabicNumerals: false,
  };
}

const slugify = s =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

async function main() {
  const owner =
    (await prisma.user.findFirst({ where: { email: 'demo-merchant@ebda.test', storeId: null } })) ??
    (await prisma.user.create({
      data: {
        email: 'demo-merchant@ebda.test',
        passwordHash: 'x-capture-only-no-login',
        firstName: 'Demo',
        lastName: 'Merchant',
        role: 'store_admin',
        emailVerified: true,
        language: 'ar',
      },
    }));
  for (const id of TEMPLATE_IDS) {
    const d = DEMO_STORES[id];
    const slug = `${id}-demo`;
    await prisma.store.deleteMany({ where: { slug } });
    const store = await prisma.store.create({
      data: {
        name: d.name.en,
        nameAr: d.name.ar,
        slug,
        ownerId: owner.id,
        status: 'active',
        plan: 'professional',
        description: d.tagline.en,
        descriptionAr: d.tagline.ar,
        currency: 'EGP',
        template: LOOK[id].template,
        theme: theme(id),
        whatsapp: '+201000000000',
        bestSellersImage: `${IMG}/${d.products[0].img}.jpg`,
        announcementBar: {
          enabled: true,
          text: ANNOUNCE[id][0],
          textAr: ANNOUNCE[id][1],
          dismissible: false,
        },
        settings: { defaultLanguage: 'ar' },
      },
    });
    const cats = [];
    for (const [i, [name, nameAr, img]] of CATEGORIES[id].entries()) {
      cats.push(
        await prisma.category.create({
          data: {
            storeId: store.id,
            name,
            nameAr,
            slug: slugify(name),
            image: `${IMG}/${img}.jpg`,
            isActive: true,
            position: i,
          },
        })
      );
    }
    for (const [i, p] of d.products.entries()) {
      const product = await prisma.product.create({
        data: {
          storeId: store.id,
          name: p.name.en,
          nameAr: p.name.ar,
          slug: slugify(p.name.en),
          description: d.tagline.en,
          descriptionAr: d.tagline.ar,
          price: p.price * 100,
          compareAtPrice: i === 1 ? Math.round(p.price * 1.2) * 100 : null,
          inventory: 25,
          status: 'active',
          featured: true,
          isNew: i < 2,
          isBestSeller: true,
          bestSellerPosition: i,
          newArrivalPosition: i,
          sku: `${id.toUpperCase()}-${i + 1}`,
          images: { create: [{ url: `${IMG}/${p.img}.jpg`, alt: p.name.ar, position: 0 }] },
          categories: { create: [{ categoryId: cats[Math.min(i, cats.length - 1)].id }] },
        },
      });
      void product;
    }

    // Published builder document, exactly as the template picker composes it.
    const heroImg = HERO_IMG[id];
    const base = shared.layoutToDefinition(
      shared.resolveLayoutSettings(
        {
          hero: {
            enabled: true,
            mode: 'single',
            autoplayMs: 5000,
            slides: [
              {
                image: `${IMG}/${heroImg}-wide.jpg`,
                imageMobile: `${IMG}/${heroImg}-tall.jpg`,
                headline: d.tagline.en,
                headlineAr: d.tagline.ar,
                ctaText: 'Shop now',
                ctaTextAr: 'تسوّق دلوقتي',
                ctaHref: '/products',
              },
            ],
          },
          categories: {
            enabled: true,
            layout: 'grid',
            captionPosition: 'below',
            desktopColumns: 3,
            mobileColumns: 3,
            title: 'Shop by category',
            titleAr: 'تسوّق حسب القسم',
          },
        },
        LOOK[id].template
      )
    );
    let doc = shared.applyTemplateFamily(base, id);
    // Fill the copy of sections the family adds from a preset (image-text, newsletter).
    doc = {
      ...doc,
      sections: doc.sections.map(n =>
        n.type === 'image-text'
          ? {
              ...n,
              settings: {
                ...n.settings,
                heading: IMAGE_TEXT[id][0],
                headingAr: IMAGE_TEXT[id][1],
                body: d.tagline.en,
                bodyAr: d.tagline.ar,
                image: `${IMG}/${d.products[1].img}.jpg`,
                buttonText: 'Shop now',
                buttonTextAr: 'تسوّق دلوقتي',
                buttonLink: '/products',
              },
            }
          : n
      ),
    };
    const v = shared.validateDefinitionSync(doc);
    if (!v.ok)
      throw new Error(`${id}: invalid definition ${JSON.stringify(v.errors).slice(0, 400)}`);
    await prisma.storePageRevision.create({
      data: {
        storeId: store.id,
        pageKey: 'home',
        rev: 1,
        status: 'published',
        schemaVersion: shared.PAGE_DEFINITION_SCHEMA_VERSION,
        document: v.definition,
        docBytes: Buffer.byteLength(JSON.stringify(v.definition), 'utf8'),
        publishedAt: new Date(),
      },
    });
    await prisma.store.update({
      where: { id: store.id },
      data: { layoutSettings: shared.definitionToLayout(v.definition) },
    });
    console.log(
      `seeded ${slug} (${store.id}): ${v.definition.sections.map(s => s.type).join(', ')}`
    );
  }
}

await main().finally(() => prisma.$disconnect());
