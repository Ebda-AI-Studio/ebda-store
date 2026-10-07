#!/usr/bin/env node
// Seed the Dahab (دهب) DEMO store — the sample jewellery brand that shows the
// Dahab template (builder Phase 3 pilot) — into a LOCAL or PREVIEW database.
//
//   DATABASE_URL=<owner-role postgres url> npx tsx scripts/dahab-demo/seed-dahab.mjs \
//     [--slug dahab-preview] [--media-base https://…/dahab] [--allow-remote]
//   OWNER_PASSWORD=…  (optional) gives the demo owner a real login for the editor
//
// What it writes, in the platform's own code paths:
//   - owner (definer `ebda_admin_user_ensure`) + store (`StoreService.create`)
//     with template `dahab`, the Dahab theme defaults, navigation, contact,
//     a demo announcement and the Growth plan;
//   - four collections, then the catalogue through the admin bulk-import path
//     (Shopify CSV → `BulkService.importProducts`), then Arabic option names;
//   - demo customers, delivered orders and published reviews (the homepage
//     testimonials read published, verified reviews);
//   - the home page document (sections + blocks) saved as a draft and
//     published through the page-builder service, which back-writes
//     layout_settings exactly as the editor's Publish button does.
//
// Safety: refuses a non-loopback DATABASE_URL unless --allow-remote. The
// preview stack passes it for the Neon branch named `preview` ONLY; never
// point this at production. Idempotent: re-running updates in place.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is required (owner role; local container or the preview branch).');
  process.exit(2);
}
const host = new URL(dbUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
const loopback = ['localhost', '127.0.0.1', '::1'].includes(host) || /^192\.168\./.test(host);
if (!loopback && !flag('--allow-remote')) {
  console.error(`Refusing non-local database host "${host}" without --allow-remote.`);
  process.exit(2);
}
process.env.DIRECT_URL ??= dbUrl;

const SLUG = opt('--slug', 'dahab-preview');
const MEDIA = opt(
  '--media-base',
  'https://pub-e8498932ac2b409ca43b80b551d53a17.r2.dev/dahab'
).replace(/\/$/, '');
const img = key => `${MEDIA}/${key}.webp`;
const OWNER_EMAIL = opt('--owner-email', 'dahab-demo@ebda.app');

const { COLLECTIONS, PRODUCTS, REVIEWS, OPTION_AR, VALUE_AR } = await import('./catalogue.mjs');
const { prisma, runInStoreScope, withOwnerTx } = await import('@force/database');
const shared = await import('@force/shared');
const { ensureAdminUser } = await import(`${root}/apps/api/src/lib/definer.ts`);
const { StoreService } = await import(`${root}/apps/api/src/services/store.service.ts`);
const { BulkService } = await import(`${root}/apps/api/src/services/bulk.service.ts`);
const { decodeCsvBytes, importCsvToPlatformCsv } = await import(
  `${root}/apps/api/src/services/csv-import.ts`
);
const { invalidateStoreProductCaches } = await import(`${root}/apps/api/src/lib/public-cache.ts`);
const { getPageState, saveDraft, publishDraft } = await import(
  `${root}/apps/api/src/services/page-builder.service.ts`
);
const { planService } = await import(`${root}/apps/api/src/services/plan.service.ts`);
const bcrypt = (await import('bcryptjs')).default;

// ── CSV (Shopify product export shape, the admin bulk import's input) ─────
const HEAD =
  'Handle,Title,Title (AR),Body (HTML),Body (HTML) (AR),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Option3 Name,Option3 Value,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Variant Price,Variant Compare At Price,Cost per item,Image Src,Image Position,Image Alt Text,Variant Image,SEO Title,SEO Description,Status';
const q = v => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = n => n.toFixed(2);
function catalogueCsv(products) {
  const lines = [HEAD];
  products.forEach(p => {
    const pi = PRODUCTS.indexOf(p);
    const collection = COLLECTIONS.find(c => c.slug === p.collection);
    const rows = p.variants ?? [{ options: {}, price: p.price, compareAt: p.compareAt }];
    const names = Object.keys(rows[0].options);
    rows.forEach((v, i) => {
      const first = i === 0;
      const image = p.images[i];
      lines.push(
        [
          p.handle,
          first ? p.name : '',
          first ? p.nameAr : '',
          first ? p.body : '',
          first ? p.bodyAr : '',
          first ? 'Dahab' : '',
          first ? 'Apparel & Accessories > Jewelry' : '',
          first ? collection.name : '',
          first ? `${p.collection}, gold` : '',
          first ? 'TRUE' : '',
          names[0] ? (first ? names[0] : '') : first ? 'Title' : '',
          names[0] ? v.options[names[0]] : first ? 'Default Title' : '',
          names[1] && first ? names[1] : '',
          names[1] ? v.options[names[1]] : '',
          '',
          '',
          `DH-${String(pi + 1).padStart(2, '0')}-${i + 1}`,
          '',
          'shopify',
          4 + ((pi + i) % 9),
          'deny',
          money(v.price ?? p.price),
          (v.compareAt ?? p.compareAt) ? money(v.compareAt ?? p.compareAt) : '',
          '',
          image ? img(image) : '',
          image ? i + 1 : '',
          image ? p.name : '',
          '',
          first ? `${p.name} | Dahab` : '',
          first ? p.body : '',
          first ? 'active' : '',
        ]
          .map(q)
          .join(',')
      );
    });
    // Images beyond the variant rows get image-only rows.
    for (let k = rows.length; k < p.images.length; k++) {
      const cells = new Array(31).fill('');
      cells[0] = p.handle;
      cells[24] = img(p.images[k]);
      cells[25] = k + 1;
      cells[26] = p.name;
      lines.push(cells.map(q).join(','));
    }
  });
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ── Home page document ─────────────────────────────────────────────────────
function homeDocument(base, productIdByHandle) {
  const { sectionFromPreset } = shared;
  const node = (type, id, settings, blocks) => {
    const n = sectionFromPreset(type, 0, id);
    n.settings = { ...n.settings, ...settings };
    if (blocks) n.blocks = blocks;
    n.hidden = false;
    return n;
  };
  const hero = node(
    'hero',
    'hero',
    { mode: 'slider', autoplayMs: 6500, presentation: 'full-bleed' },
    [
      {
        id: 'slide-1',
        type: 'slide',
        settings: {
          image: img('hero-1'),
          imageMobile: img('hero-1-mobile'),
          alt: 'Woman wearing gold earrings and a gold collar',
          headline: 'Gold you live in',
          headlineAr: 'دهب يتلبس كل يوم',
          ctaText: 'Shop the collection',
          ctaTextAr: 'تسوق المجموعة',
          ctaHref: '/products',
        },
      },
      {
        id: 'slide-2',
        type: 'slide',
        settings: {
          image: img('hero-2'),
          imageMobile: img('hero-2-mobile'),
          alt: 'Portrait in low light wearing a fine gold chain',
          headline: 'Fine chains, 18K and 21K',
          headlineAr: 'سلاسل رفيعة، عيار 18 و21',
          ctaText: 'See the necklaces',
          ctaTextAr: 'شوف السلاسل',
          ctaHref: '/products?category=necklaces',
        },
      },
    ]
  );
  const collections = node(
    'collection-list',
    'collections',
    {
      heading: 'Shop by collection',
      headingAr: 'تسوق حسب المجموعة',
      tileShape: 'arch',
      columns: 4,
      paddingBottom: 'loose',
    },
    COLLECTIONS.map((c, i) => ({
      id: `collection-${i + 1}`,
      type: 'collection',
      settings: { categorySlug: c.slug, image: img(c.image) },
    }))
  );
  const newIn = node('featured-collection', 'new-in', {
    heading: 'New in',
    headingAr: 'وصل حديثاً',
    subheading: 'Pieces from this month’s workshop run.',
    subheadingAr: 'قطع من شغل الورشة الشهر ده.',
    productSource: 'newest',
    limit: 8,
    columns: 4,
    mobileColumns: 2,
    buttonText: 'View all',
    buttonTextAr: 'عرض الكل',
    buttonLink: '/products?sort=newest',
  });
  const craft = node('image-text', 'craft', {
    image: img('story-craft'),
    alt: 'A goldsmith shaping a ring at the bench',
    altAr: 'صايغ بيشكّل خاتم على البنك',
    heading: 'Made at the bench, in Cairo',
    headingAr: 'شغل إيد، في ورشة بالقاهرة',
    body: 'Every piece is cast, filed and polished by hand in our workshop, then stamped by the Egyptian Assay Office. You pay for the gold and the work, priced openly.',
    bodyAr:
      'كل قطعة بتتصب وتتبرد وتتلمع بالإيد في ورشتنا، وبعدها بتتدمغ من مصلحة الدمغة والموازين. بتدفع تمن الدهب والمصنعية، وكل حاجة واضحة.',
    buttonText: 'Our story',
    buttonTextAr: 'حكايتنا',
    buttonLink: '/about',
    imagePosition: 'start',
    imageAspect: 'portrait',
  });
  const gifts = node('product-spotlight', 'gift-ideas', {
    image: img('gift-tray'),
    alt: 'A tray of gold charms and chains',
    altAr: 'صينية فيها دلايات وسلاسل دهب',
    heading: 'Gift ideas',
    headingAr: 'أفكار للهدايا',
    body: 'Small pieces that arrive gift-wrapped, with a card in your words.',
    bodyAr: 'قطع صغيرة بتوصل متغلفة هدية، ومعاها كارت بكلامك.',
    productSource: 'manual',
    manualProductIds: ['evil-eye-bracelet', 'drop-earrings', 'teardrop-pendant']
      .map(h => productIdByHandle.get(h))
      .filter(Boolean),
    limit: 3,
    imagePosition: 'end',
    buttonText: 'All gifts under 10,000 EGP',
    buttonTextAr: 'كل الهدايا أقل من 10,000 ج.م',
    buttonLink: '/products?maxPrice=10000',
  });
  const bestsellers = node('featured-collection', 'necklaces', {
    heading: 'Necklaces',
    headingAr: 'سلاسل',
    productSource: 'category',
    categorySlug: 'necklaces',
    limit: 4,
    columns: 4,
    mobileColumns: 2,
    buttonText: 'All necklaces',
    buttonTextAr: 'كل السلاسل',
    buttonLink: '/products?category=necklaces',
  });
  const testimonials = node('testimonials', 'testimonials', {
    title: 'In their words',
    titleAr: 'قالوا عننا',
    minRating: 4,
    verifiedOnly: true,
  });
  const trust = node('trust-badges', 'trust', { layout: 'row' }, [
    {
      id: 'badge-1',
      type: 'badge',
      settings: {
        icon: 'cod',
        title: 'Cash on delivery',
        titleAr: 'الدفع عند الاستلام',
        text: 'Pay when it reaches you.',
        textAr: 'ادفع لما القطعة توصلك.',
      },
    },
    {
      id: 'badge-2',
      type: 'badge',
      settings: {
        icon: 'instapay',
        title: 'InstaPay and cards',
        titleAr: 'إنستاباي والكروت',
        text: 'Meeza, Visa and Mastercard.',
        textAr: 'ميزة وفيزا وماستركارد.',
      },
    },
    {
      id: 'badge-3',
      type: 'badge',
      settings: {
        icon: 'shipping',
        title: 'Delivery across Egypt',
        titleAr: 'توصيل لكل مصر',
        text: 'Insured, in a sealed box.',
        textAr: 'مؤمّن عليه، في علبة مقفولة.',
      },
    },
    {
      id: 'badge-4',
      type: 'badge',
      settings: {
        icon: 'certified',
        title: 'Hallmarked gold',
        titleAr: 'دهب مدموغ',
        text: 'Stamped by the Assay Office.',
        textAr: 'مدموغ من مصلحة الدمغة.',
      },
    },
  ]);
  const newsletter = node('newsletter', 'newsletter', {
    heading: 'Hear about new pieces first',
    headingAr: 'اعرف القطع الجديدة الأول',
    body: 'One email when a new run leaves the workshop. Nothing else.',
    bodyAr: 'إيميل واحد لما شغل جديد يطلع من الورشة. مفيش غيره.',
    buttonText: 'Sign up',
    buttonTextAr: 'اشترك',
  });
  // Legacy sections the document does not use stay present but hidden, so
  // publishing writes an explicit "off" into layout_settings.
  const hiddenLegacy = base.sections
    .filter(n => !['hero', 'testimonials'].includes(n.type))
    .filter(n => shared.getSectionDefinition(n.type)?.legacyKey)
    .map(n => ({ ...n, hidden: true }));
  return {
    ...base,
    sectionGroups: {
      header: base.sectionGroups.header.map(n => ({
        ...n,
        hidden: false,
        settings: { ...n.settings, ...(n.type === 'header' ? { sticky: true } : {}) },
      })),
      footer: base.sectionGroups.footer.map(n => ({ ...n, hidden: false })),
    },
    sections: [
      hero,
      collections,
      newIn,
      craft,
      gifts,
      bestsellers,
      testimonials,
      trust,
      newsletter,
      ...hiddenLegacy,
    ],
  };
}

try {
  // ── owner ──────────────────────────────────────────────────────────────
  const passwordHash = process.env.OWNER_PASSWORD
    ? await bcrypt.hash(process.env.OWNER_PASSWORD, 12)
    : '!seed-no-login';
  const owner = await ensureAdminUser({
    email: OWNER_EMAIL,
    passwordHash,
    firstName: 'Dahab',
    lastName: 'Demo',
    role: 'store_admin',
    emailVerified: true,
  });
  if (process.env.OWNER_PASSWORD) {
    await withOwnerTx(tx =>
      tx.user.update({ where: { id: owner.id }, data: { passwordHash, language: 'ar' } })
    );
  }

  // ── store ──────────────────────────────────────────────────────────────
  let store = await prisma.store.findUnique({ where: { slug: SLUG } });
  if (!store)
    store = await StoreService.create(
      owner.id,
      { name: 'Dahab', slug: SLUG },
      { platformOperator: true }
    );
  const theme = shared.getTemplateTheme('dahab');
  await withOwnerTx(tx =>
    tx.store.update({
      where: { id: store.id },
      data: {
        name: 'Dahab',
        nameAr: 'دهب',
        description: 'Gold jewellery in 18K and 21K, made by hand in a Cairo workshop.',
        descriptionAr: 'مجوهرات دهب عيار 18 و21، شغل إيد في ورشة بالقاهرة.',
        currency: 'EGP',
        status: 'active',
        template: 'dahab',
        theme,
        email: 'hello@dahab.example',
        phone: '+20 100 000 0000',
        address: 'Workshop 4, Al-Muizz Street, Gamaleya, Cairo',
        addressAr: 'ورشة 4، شارع المعز، الجمالية، القاهرة',
        socialLinks: { instagram: 'https://instagram.com/', facebook: 'https://facebook.com/' },
        announcementBar: {
          enabled: true,
          text: 'Demo store — the Dahab template by Ebda. Cash on delivery and InstaPay.',
          textAr: 'متجر تجريبي — قالب دهب من ابدأ. الدفع عند الاستلام وإنستاباي.',
        },
        settings: {
          ...(store.settings ?? {}),
          currency: 'EGP',
          locale: 'ar-EG',
          defaultLanguage: 'ar',
          navMenu: [
            ...COLLECTIONS.map(c => ({
              label: c.name,
              labelAr: c.nameAr,
              href: `/products?category=${c.slug}`,
            })),
            { label: 'Our story', labelAr: 'حكايتنا', href: '/about' },
          ],
          footerLinks: { newsletterEnabled: false },
        },
      },
    })
  );
  await planService.assignPlan(store.id, { planCode: 'growth' }).catch(() => undefined);

  // ── collections ────────────────────────────────────────────────────────
  await withOwnerTx(async tx => {
    for (const [i, c] of COLLECTIONS.entries()) {
      await tx.category.upsert({
        where: { storeId_slug: { storeId: store.id, slug: c.slug } },
        update: {
          name: c.name,
          nameAr: c.nameAr,
          image: img(c.image),
          position: i,
          isActive: true,
        },
        create: {
          storeId: store.id,
          name: c.name,
          nameAr: c.nameAr,
          slug: c.slug,
          image: img(c.image),
          position: i,
        },
      });
    }
  });

  // ── catalogue (admin bulk-import path) ─────────────────────────────────
  // In chunks: one import call is one transaction (30s cap), and a remote
  // seed (the preview branch) pays a network round trip per statement.
  const result = { total: 0, created: 0, updated: 0, variantsCreated: 0, failed: 0 };
  for (let i = 0; i < PRODUCTS.length; i += 3) {
    const converted = importCsvToPlatformCsv(
      decodeCsvBytes(catalogueCsv(PRODUCTS.slice(i, i + 3)))
    );
    const r = await runInStoreScope(store.id, () =>
      BulkService.importProducts(store.id, converted.csv, { updateExisting: true }, owner.id)
    );
    for (const k of Object.keys(result)) result[k] += r[k] ?? 0;
    if (r.failed > 0) console.error(JSON.stringify(r.errors, null, 2));
  }

  // Flags the CSV cannot carry + Arabic option labels.
  const productIdByHandle = new Map();
  await withOwnerTx(async tx => {
    const products = await tx.product.findMany({
      where: { storeId: store.id },
      select: { id: true, slug: true },
    });
    const bySlug = new Map(products.map(p => [p.slug, p.id]));
    const now = Date.now();
    for (const [i, p] of PRODUCTS.entries()) {
      const id = bySlug.get(p.handle);
      if (!id) continue;
      productIdByHandle.set(p.handle, id);
      await tx.product.update({
        where: { id },
        data: {
          status: 'active',
          featured: p.featured === true,
          isNew: p.isNew === true,
          badgeLabel: p.badge ?? null,
          badgeLabelAr: p.badgeAr ?? null,
          // Plain text: the PDP renders descriptions as text, not HTML.
          description: p.body,
          descriptionAr: p.bodyAr,
          excerpt: p.body.split('. ')[0] + '.',
          excerptAr: p.bodyAr.split('. ')[0].replace(/\.$/, '') + '.',
          // Stagger so "newest" has a stable, catalogue-like order.
          createdAt: new Date(now - (PRODUCTS.length - i) * 36e5),
        },
      });
      const options = await tx.productOption.findMany({
        where: { productId: id },
        include: { values: true },
      });
      for (const o of options) {
        if (OPTION_AR[o.name])
          await tx.productOption.update({
            where: { id: o.id },
            data: { nameAr: OPTION_AR[o.name] },
          });
        for (const v of o.values)
          if (VALUE_AR[v.value])
            await tx.productOptionValue.update({
              where: { id: v.id },
              data: { valueAr: VALUE_AR[v.value] },
            });
      }
    }
  });

  // ── demo customers, delivered orders, published reviews ────────────────
  await withOwnerTx(async tx => {
    for (const [i, r] of REVIEWS.entries()) {
      const productId = productIdByHandle.get(r.product);
      if (!productId) continue;
      const email = `dahab-demo-customer-${i + 1}@example.com`;
      const customer =
        (await tx.user.findFirst({ where: { storeId: store.id, email } })) ??
        (await tx.user.create({
          data: {
            storeId: store.id,
            email,
            passwordHash: '!seed-no-login',
            role: 'customer',
            firstName: r.name[0],
            lastName: r.name[1],
          },
        }));
      const orderNumber = `DH-DEMO-${String(i + 1).padStart(4, '0')}`;
      const address = {
        firstName: r.name[0],
        lastName: r.name[1],
        city: 'Cairo',
        country: 'EG',
        address1: 'Demo address',
      };
      const order =
        (await tx.order.findUnique({ where: { orderNumber } })) ??
        (await tx.order.create({
          data: {
            storeId: store.id,
            orderNumber,
            customerId: customer.id,
            subtotal: 0,
            total: 0,
            status: 'delivered',
            shippingAddress: address,
            billingAddress: address,
          },
        }));
      await tx.review.upsert({
        where: { orderId_productId: { orderId: order.id, productId } },
        update: { rating: r.rating, body: r.body, status: 'published', language: 'ar' },
        create: {
          storeId: store.id,
          productId,
          orderId: order.id,
          customerId: customer.id,
          rating: r.rating,
          body: r.body,
          language: 'ar',
          status: 'published',
          verifiedPurchase: true,
        },
      });
    }
  });

  // ── home page document: draft → publish (the editor's own service) ─────
  const published = await runInStoreScope(store.id, async () => {
    const state = await getPageState(store.id, 'home');
    const doc = homeDocument(state.definition, productIdByHandle);
    const saved = await saveDraft({
      storeId: store.id,
      pageKey: 'home',
      baseRev: state.rev,
      definition: doc,
      userId: owner.id,
    });
    if (!saved.ok)
      throw new Error(`saveDraft: ${saved.message} ${JSON.stringify(saved.errors ?? [])}`);
    const pub = await publishDraft({
      storeId: store.id,
      pageKey: 'home',
      baseRev: saved.value.rev,
    });
    if (!pub.ok) throw new Error(`publishDraft: ${pub.message}`);
    return pub.value.rev;
  });
  await invalidateStoreProductCaches(store.id);

  console.log(
    JSON.stringify(
      {
        store: { id: store.id, slug: SLUG },
        owner: { email: OWNER_EMAIL, canLogIn: !!process.env.OWNER_PASSWORD },
        import: {
          total: result.total,
          created: result.created,
          updated: result.updated,
          variantsCreated: result.variantsCreated,
          failed: result.failed,
        },
        reviews: REVIEWS.length,
        homeRevision: published,
      },
      null,
      2
    )
  );
  process.exitCode = result.failed > 0 ? 1 : 0;
} finally {
  await prisma.$disconnect();
  // The API modules leave a Redis client and timers open; this is a one-shot script.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
