/**
 * Demo Store Seed — Force Website Builder
 *
 * Creates (or fully refreshes) ONE rich demo store used for:
 *   • Admin-dashboard tutorial video recording
 *   • Showcasing every platform feature to prospective merchants
 *
 * Slug: `demo`  |  Name: "Force Demo Store" / "متجر فورس التجريبي"
 * Plan: enterprise (all feature toggles ON)
 *
 * What it seeds
 * ─────────────
 * Store config  — modern template, brand colours, hero slides, bilingual, KWD,
 *                 every theme flag enabled (loyalty, blog, reviews, quick-add, …)
 * Categories    — 6 bilingual categories with position, showOnHomeStrip mix
 * Products      — ~25 products spanning 5 variant shapes:
 *   Shape 1 — simple (no variants)
 *   Shape 2 — 1 option: Size (S/M/L) → 3 variants
 *   Shape 3 — 1 option: Color (Red/Blue/Black) → 3 variants
 *   Shape 4 — 2 options: Size × Color → 9 variants (3×3 matrix)
 *   Shape 5 — 3 options: Size × Color × Material → 8 variants (2×2×2 sample)
 * Customers     — 10 sample customers
 * Orders        — 15 orders spanning every OrderStatus + COD/online mixes
 * Reviews       — 15 product reviews (varied ratings)
 * Loyalty       — points records for several customers
 * Coupons       — 3 demo coupons
 *
 * Idempotency
 * ───────────
 * • Store: upserted by slug (`demo`) — existing row is fully overwritten.
 * • Categories: deleted + recreated each run (scoped to this store only).
 * • Products: upserted by (storeId, sku) — stable SKU keys guarantee idempotency.
 * • Orders / Reviews / Loyalty: deleted then recreated each run for this store.
 * • NEVER touches rows belonging to other stores.
 *
 * Usage
 * ─────
 *   railway run npx tsx packages/database/prisma/seed-demo-store.ts
 *
 * Or via the npm script (from repo root or packages/database):
 *   npm run db:seed:demo -w @force/database
 *
 * Requires: DATABASE_URL + DIRECT_URL env vars (Railway provides these).
 * No ADMIN_PASSWORD needed — reuses the first super_admin already in the DB.
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── Constants ───────────────────────────────────────────────────────────────

const DEMO_SLUG = 'demo';
const DEMO_OWNER_EMAIL = 'admin@forcemediakw.com'; // fallback if no super_admin yet

/** Price in fils (1 KWD = 1000 fils) */
function fils(kwd: number): number {
  return Math.round(kwd * 1000);
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// All feature keys the platform supports (mirrors FEATURE_KEYS_ARRAY in @force/shared).
const ALL_FEATURE_KEYS = [
  'coupons',
  'loyalty',
  'returns',
  'reviews',
  'inventory',
  'tax',
  'bulk_operations',
  'customer_wallet',
  'upsell_crosssell',
  'whatsapp',
  'sms',
  'push_notifications',
  'email_campaigns',
  'abandoned_cart',
  'affiliate',
  'marketing_pixels',
  'shipping_carriers',
  'staff_accounts',
  'pwa',
  'seo',
  'search_autocomplete',
  'floating_widget',
  'inventory.basic',
  'inventory.stock_alerts',
  'inventory.backorder',
  'inventory.multi_warehouse',
  'inventory.barcode',
  'inventory.purchase_orders',
  'inventory.bulk_adjustments',
  'payment_abandonment',
  'accounting.basic',
  'accounting.expenses',
  'accounting.invoicing',
  'accounting.tax_reports',
  'accounting.multi_currency',
  'accounting.profit_anomaly',
  'accounting.bank_reconcile',
] as const;

// ─── Hero slides (bilingual) ──────────────────────────────────────────────────

const HERO_SLIDES = [
  {
    title: 'Welcome to Force Demo Store',
    titleAr: 'مرحباً بك في متجر فورس التجريبي',
    subtitle: 'Discover our curated collection — premium products at great prices.',
    subtitleAr: 'اكتشف مجموعتنا المختارة — منتجات فاخرة بأسعار رائعة.',
    ctaText: 'Shop Now',
    ctaTextAr: 'تسوق الآن',
    ctaLink: '/products',
    image: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1600&q=80',
  },
  {
    title: 'New Season Collection',
    titleAr: 'مجموعة الموسم الجديد',
    subtitle: "Fresh styles that define the season — explore what's new.",
    subtitleAr: 'أساليب جديدة تحدد الموسم — استكشف الجديد.',
    ctaText: 'View New Arrivals',
    ctaTextAr: 'استعرض الوافدين الجدد',
    ctaLink: '/products?isNew=true',
    image: 'https://images.unsplash.com/photo-1555529669-e69e7aa0ba9a?w=1600&q=80',
  },
  {
    title: 'Up to 30% Off Best Sellers',
    titleAr: 'خصم يصل إلى ٣٠٪ على الأكثر مبيعاً',
    subtitle: 'Our most-loved products — now at an even better value.',
    subtitleAr: 'منتجاتنا الأكثر حباً — بقيمة أفضل.',
    ctaText: 'See Best Sellers',
    ctaTextAr: 'الأكثر مبيعاً',
    ctaLink: '/products?isBestSeller=true',
    image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=1600&q=80',
  },
];

// ─── Categories ───────────────────────────────────────────────────────────────

const CATEGORIES = [
  {
    name: 'Electronics',
    nameAr: 'إلكترونيات',
    description: 'Phones, laptops, gadgets and accessories',
    descriptionAr: 'هواتف، لابتوبات، أجهزة وإكسسوارات',
    image: 'https://images.unsplash.com/photo-1525547719571-a2d4ac8945e2?w=600',
    position: 0,
    showOnHomeStrip: true,
  },
  {
    name: 'Fashion',
    nameAr: 'أزياء',
    description: 'Clothing and style essentials',
    descriptionAr: 'ملابس وأساسيات الأناقة',
    image: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=600',
    position: 1,
    showOnHomeStrip: true,
  },
  {
    name: 'Home & Living',
    nameAr: 'المنزل والمعيشة',
    description: 'Furniture, decor and everyday home essentials',
    descriptionAr: 'أثاث وديكور وأساسيات المنزل',
    image: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=600',
    position: 2,
    showOnHomeStrip: true,
  },
  {
    name: 'Beauty & Wellness',
    nameAr: 'الجمال والعافية',
    description: 'Skincare, fragrances and wellness products',
    descriptionAr: 'العناية بالبشرة والعطور ومنتجات العافية',
    image: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=600',
    position: 3,
    showOnHomeStrip: true,
  },
  {
    name: 'Sports & Outdoors',
    nameAr: 'الرياضة والهواء الطلق',
    description: 'Activewear, equipment and outdoor gear',
    descriptionAr: 'الملابس الرياضية والمعدات والعتاد الخارجي',
    image: 'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=600',
    position: 4,
    showOnHomeStrip: false, // demonstrates mix — not shown on home strip
  },
  {
    name: 'Food & Gourmet',
    nameAr: 'الأغذية والذواقة',
    description: 'Premium food, snacks and gourmet treats',
    descriptionAr: 'أطعمة فاخرة ووجبات خفيفة ومأكولات راقية',
    image: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600',
    position: 5,
    showOnHomeStrip: true,
  },
] as const;

// ─── Product definitions ───────────────────────────────────────────────────────
//
// Convention for prices: fils (1 KWD = 1000 fils).
// "sku" must be unique per store — we prefix with DEMO- for stable idempotency.

const PRODUCTS_SIMPLE = [
  // ── Shape 1: Simple products (no variants) ──────────────────────────────
  {
    shape: 'simple' as const,
    name: 'Wireless Noise-Cancelling Headphones',
    nameAr: 'سماعات رأس لاسلكية بخاصية إلغاء الضوضاء',
    description:
      'Premium over-ear headphones with 40-hour battery life and active noise cancellation. Perfect for travel, work, and music lovers.',
    descriptionAr:
      'سماعات رأس فاخرة بعمر بطارية 40 ساعة وإلغاء نشط للضوضاء. مثالية للسفر والعمل وعشاق الموسيقى.',
    sku: 'DEMO-HDPH-001',
    category: 'Electronics',
    price: fils(45),
    compareAtPrice: fils(60),
    inventory: 35,
    status: 'active' as const,
    featured: true,
    isNew: true,
    isBestSeller: true,
    newArrivalPosition: 1,
    bestSellerPosition: 1,
    images: [
      'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
      'https://images.unsplash.com/photo-1583394838336-acd977736f90?w=800',
    ],
  },
  {
    shape: 'simple' as const,
    name: 'Portable Bluetooth Speaker',
    nameAr: 'مكبر صوت بلوتوث محمول',
    description:
      'Compact, waterproof speaker with 360° sound. IPX7 water resistance and 20-hour playtime.',
    descriptionAr: 'مكبر صوت مدمج ومقاوم للماء بصوت 360°. مقاومة للماء IPX7 ووقت تشغيل 20 ساعة.',
    sku: 'DEMO-SPKR-001',
    category: 'Electronics',
    price: fils(22),
    compareAtPrice: null,
    inventory: 0, // out of stock — demonstrates edge state
    status: 'active' as const,
    featured: false,
    isNew: false,
    isBestSeller: false,
    newArrivalPosition: 0,
    bestSellerPosition: 0,
    images: ['https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=800'],
  },
  {
    shape: 'simple' as const,
    name: 'Scented Oud Candle',
    nameAr: 'شمعة عود معطرة',
    description:
      'Hand-poured soy-wax candle with authentic Arabian oud fragrance. Burns for 60+ hours.',
    descriptionAr:
      'شمعة مصنوعة يدوياً من شمع الصويا بعطر العود العربي الأصيل. تحترق أكثر من 60 ساعة.',
    sku: 'DEMO-CNDL-001',
    category: 'Home & Living',
    price: fils(9.5),
    compareAtPrice: null,
    inventory: 80,
    status: 'active' as const,
    featured: false,
    isNew: true,
    isBestSeller: true,
    newArrivalPosition: 3,
    bestSellerPosition: 4,
    images: ['https://images.unsplash.com/photo-1602874801007-bd458bb1b8b6?w=800'],
  },
  {
    shape: 'simple' as const,
    name: 'Luxury Rose Face Serum',
    nameAr: 'سيروم الوجه الفاخر بالورد',
    description:
      'Lightweight brightening serum with 5% niacinamide and rose hip oil. Reduces dark spots in 4 weeks.',
    descriptionAr:
      'سيروم مضيء خفيف الوزن مع 5٪ نياسيناميد وزيت ثمر الورد. يقلل البقع الداكنة في 4 أسابيع.',
    sku: 'DEMO-SERUM-001',
    category: 'Beauty & Wellness',
    price: fils(14),
    compareAtPrice: fils(18),
    inventory: 60,
    status: 'active' as const,
    featured: true,
    isNew: false,
    isBestSeller: true,
    newArrivalPosition: 0,
    bestSellerPosition: 2,
    images: ['https://images.unsplash.com/photo-1614859324669-927e70f7a4b2?w=800'],
  },
  {
    shape: 'simple' as const,
    name: 'Artisan Honey Gift Box',
    nameAr: 'صندوق هدايا العسل الحرفي',
    description:
      'Assortment of three premium raw honeys — Sidr, Manuka, and Wildflower — in a beautiful gift box.',
    descriptionAr:
      'تشكيلة من ثلاثة عسول خام فاخرة — سدر، مانوكا، وزهور برية — في صندوق هدايا جميل.',
    sku: 'DEMO-HNYGFT-001',
    category: 'Food & Gourmet',
    price: fils(28),
    compareAtPrice: null,
    inventory: 15,
    status: 'active' as const,
    featured: false,
    isNew: true,
    isBestSeller: false,
    newArrivalPosition: 5,
    bestSellerPosition: 0,
    images: ['https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=800'],
  },
  {
    shape: 'simple' as const,
    name: 'Yoga Mat Pro',
    nameAr: 'حصيرة يوغا احترافية',
    description:
      '6mm eco-friendly TPE yoga mat with alignment lines. Non-slip surface with carry strap.',
    descriptionAr:
      'حصيرة يوغا صديقة للبيئة بسماكة 6 ملم مع خطوط محاذاة. سطح غير قابل للانزلاق مع حزام حمل.',
    sku: 'DEMO-YOGA-001',
    category: 'Sports & Outdoors',
    price: fils(12),
    compareAtPrice: fils(16),
    inventory: 42,
    status: 'active' as const,
    featured: false,
    isNew: false,
    isBestSeller: false,
    newArrivalPosition: 0,
    bestSellerPosition: 0,
    images: ['https://images.unsplash.com/photo-1601925228208-8cee93ef6e6e?w=800'],
  },
  {
    shape: 'simple' as const,
    name: 'Handmade Ceramic Mug Set',
    nameAr: 'طقم أكواب سيراميك مصنوعة يدوياً',
    description:
      'Set of 4 artisan ceramic mugs, each uniquely hand-thrown and glazed. Dishwasher safe.',
    descriptionAr: 'طقم من 4 أكواب سيراميك حرفية، كل منها مصنوع يدوياً وملمّع. آمن لغسالة الأطباق.',
    sku: 'DEMO-MUG-001',
    category: 'Home & Living',
    price: fils(18.5),
    compareAtPrice: null,
    inventory: 22,
    status: 'active' as const,
    featured: true,
    isNew: false,
    isBestSeller: true,
    newArrivalPosition: 0,
    bestSellerPosition: 3,
    images: ['https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=800'],
  },
  {
    shape: 'simple' as const,
    name: 'Premium Arabic Oud Perfume',
    nameAr: 'عطر العود العربي الفاخر',
    description:
      'Rich, long-lasting oud-based fragrance with notes of amber, rose, and sandalwood. 50ml.',
    descriptionAr: 'عطر غني وطويل الأمد بالعود مع نفحات العنبر والورد وخشب الصندل. 50 مل.',
    sku: 'DEMO-PERF-001',
    category: 'Beauty & Wellness',
    price: fils(35),
    compareAtPrice: fils(45),
    inventory: 28,
    status: 'active' as const,
    featured: true,
    isNew: false,
    isBestSeller: true,
    newArrivalPosition: 0,
    bestSellerPosition: 5,
    images: ['https://images.unsplash.com/photo-1523293182086-7651a899d37f?w=800'],
  },
];

// ─── Variant products are created programmatically below (not simple data objects).

// ─── Customer data ────────────────────────────────────────────────────────────

const CUSTOMERS = [
  {
    firstName: 'Ahmad',
    lastName: 'Al-Sabah',
    email: 'ahmad.sabah@demo.test',
    phone: '+96599001001',
  },
  {
    firstName: 'Fatima',
    lastName: 'Al-Rashid',
    email: 'fatima.rashid@demo.test',
    phone: '+96599001002',
  },
  {
    firstName: 'Mohammed',
    lastName: 'Al-Mutawa',
    email: 'mohammed.mutawa@demo.test',
    phone: '+96599001003',
  },
  { firstName: 'Sara', lastName: 'Al-Essa', email: 'sara.essa@demo.test', phone: '+96599001004' },
  {
    firstName: 'Khalid',
    lastName: 'Al-Fahad',
    email: 'khalid.fahad@demo.test',
    phone: '+96599001005',
  },
  {
    firstName: 'Noor',
    lastName: 'Al-Hamdan',
    email: 'noor.hamdan@demo.test',
    phone: '+96599001006',
  },
  {
    firstName: 'Tariq',
    lastName: 'Al-Mansouri',
    email: 'tariq.mansouri@demo.test',
    phone: '+96599001007',
  },
  {
    firstName: 'Layla',
    lastName: 'Al-Khaled',
    email: 'layla.khaled@demo.test',
    phone: '+96599001008',
  },
  { firstName: 'Yousef', lastName: 'Al-Ali', email: 'yousef.ali@demo.test', phone: '+96599001009' },
  {
    firstName: 'Maryam',
    lastName: 'Al-Badr',
    email: 'maryam.badr@demo.test',
    phone: '+96599001010',
  },
];

// ─── Shared shipping / billing address template ───────────────────────────────

function address(firstName: string, lastName: string) {
  return {
    firstName,
    lastName,
    address1: '12 Block 5',
    address2: 'Jabriya',
    city: 'Kuwait City',
    state: 'Hawalli',
    country: 'Kuwait',
    phone: '+965 99001234',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      Force Demo Store — Seed Script              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // 1. Resolve owner (first super_admin, or fallback email)
  const owner = await prisma.user.findFirst({
    where: { role: 'super_admin', deletedAt: null },
  });
  if (!owner) {
    throw new Error(
      `No super_admin user found. Run the main seed first:\n  railway run npm run db:seed -w @force/database\n  (sets ADMIN_EMAIL=${DEMO_OWNER_EMAIL})`
    );
  }
  console.log(`Owner: ${owner.email} (id=${owner.id})`);

  // 2. Upsert the demo store
  console.log('\n[1/7] Upserting demo store…');
  const existingStore = await prisma.store.findFirst({ where: { slug: DEMO_SLUG } });

  const storeData = {
    name: 'Force Demo Store',
    nameAr: 'متجر فورس التجريبي',
    ownerId: owner.id,
    status: 'active' as const,
    plan: 'enterprise' as const,
    template: 'modern' as const,
    currency: 'KWD',
    description:
      'The Force Demo Store showcases every feature of the Force Website Builder platform — product variants, loyalty, reviews, blog, and more.',
    descriptionAr:
      'يعرض متجر فورس التجريبي كل ميزات منصة Force Website Builder — متغيرات المنتج، الولاء، التقييمات، المدونة، وأكثر.',
    email: 'demo@forcemediakw.com',
    phone: '+965 9999 0000',
    phoneAr: '+٩٦٥ ٩٩٩٩ ٠٠٠٠',
    whatsapp: '+96599990000',
    address: 'Kuwait City, Kuwait',
    addressAr: 'مدينة الكويت، الكويت',
    // Theme — all opt-in flags ON for demo
    theme: {
      primaryColor: '26 100% 50%',
      primaryForeground: '0 0% 100%',
      secondaryColor: '220 14% 96%',
      secondaryForeground: '220 9% 46%',
      fontFamily: 'modern',
      borderRadius: 'lg',
      showBrandBadge: true,
      showQuickAdd: true,
      showBrandStory: true,
      showTrustStrip: true,
      trustStripLayout: 'horizontal',
      showBestSellersTile: true,
      backgroundPreset: 'none',
    },
    // Layout — hero slides + category copy
    layoutSettings: {
      hero: {
        slides: HERO_SLIDES,
      },
      categories: {
        title: 'Shop by Category',
        titleAr: 'تسوق حسب الفئة',
        subtitle: 'Explore our curated collections',
        subtitleAr: 'استكشف مجموعاتنا المختارة',
        kicker: 'Collections',
        kickerAr: 'المجموعات',
      },
    },
    // Feature toggles are handled separately via StoreFeature upserts
    loyaltyEnabled: true,
    loyaltySettings: {
      pointsPerKwd: 10,
      minRedeemPoints: 100,
      pointsValueKwd: 0.001,
      welcomeBonus: 100,
      reviewBonus: 50,
      birthdayBonus: 200,
    },
    blogEnabled: true,
    locationsEnabled: false,
    pwaEnabled: true,
    pwaSettings: { themeColor: '#ff6e01', backgroundColor: '#ffffff' },
    socialLinks: {
      instagram: 'https://instagram.com/forcemediakw',
      twitter: 'https://twitter.com/forcemediakw',
      whatsapp: '+96599990000',
    },
    announcementBar: {
      enabled: true,
      text: 'Free shipping on orders over 10 KWD — Use code WELCOME10 for 10% off!',
      textAr: 'شحن مجاني للطلبات فوق 10 د.ك — استخدم كود WELCOME10 للحصول على خصم 10٪!',
      bgColor: '26 100% 50%',
      textColor: '0 0% 100%',
    },
    metaTitle: 'Force Demo Store — Premium Products',
    metaTitleAr: 'متجر فورس التجريبي — منتجات فاخرة',
    metaDescription: 'Discover the full range of Force Website Builder features in our demo store.',
    metaDescriptionAr: 'اكتشف النطاق الكامل لميزات منصة Force Website Builder في متجرنا التجريبي.',
    marketingPixels: {},
    taxEnabled: false,
    accountingEnabled: true,
    aiFeaturesEnabled: true,
  };

  const store = existingStore
    ? await prisma.store.update({ where: { id: existingStore.id }, data: storeData })
    : await prisma.store.create({ data: { ...storeData, slug: DEMO_SLUG } });

  console.log(`  ✓ store id=${store.id}  slug=${store.slug}`);

  // 3. Enable all feature flags
  console.log('\n[2/7] Enabling all feature flags…');
  for (const key of ALL_FEATURE_KEYS) {
    await prisma.storeFeature.upsert({
      where: { storeId_featureKey: { storeId: store.id, featureKey: key } },
      update: { enabled: true, enabledAt: new Date() },
      create: { storeId: store.id, featureKey: key, enabled: true, enabledAt: new Date() },
    });
  }
  console.log(`  ✓ ${ALL_FEATURE_KEYS.length} features enabled`);

  // 4. Categories — delete then recreate (scoped to this store only)
  console.log('\n[3/7] Seeding categories…');
  await prisma.category.deleteMany({ where: { storeId: store.id } });
  const catMap = new Map<string, string>(); // English name → id
  for (const cat of CATEGORIES) {
    const created = await prisma.category.create({
      data: {
        storeId: store.id,
        name: cat.name,
        nameAr: cat.nameAr,
        slug: slug(cat.name),
        description: cat.description,
        descriptionAr: cat.descriptionAr,
        image: cat.image,
        position: cat.position,
        showOnHomeStrip: cat.showOnHomeStrip,
        isActive: true,
      },
    });
    catMap.set(cat.name, created.id);
  }
  console.log(`  ✓ ${catMap.size} categories`);

  // ── Helper: upsert a product by (storeId, sku) ────────────────────────────
  async function upsertSimpleProduct(data: {
    name: string;
    nameAr: string;
    description: string;
    descriptionAr: string;
    sku: string;
    category: string;
    price: number;
    compareAtPrice: number | null;
    inventory: number;
    status: 'active' | 'draft' | 'archived';
    featured: boolean;
    isNew: boolean;
    isBestSeller: boolean;
    newArrivalPosition: number;
    bestSellerPosition: number;
    images: string[];
  }) {
    const existing = await prisma.product.findFirst({
      where: { storeId: store.id, sku: data.sku },
      include: { images: true, categories: true },
    });

    const productData = {
      storeId: store.id,
      name: data.name,
      nameAr: data.nameAr,
      slug: slug(data.name),
      description: data.description,
      descriptionAr: data.descriptionAr,
      sku: data.sku,
      price: data.price,
      compareAtPrice: data.compareAtPrice ?? null,
      inventory: data.inventory,
      status: data.status,
      featured: data.featured,
      isNew: data.isNew,
      isBestSeller: data.isBestSeller,
      newArrivalPosition: data.newArrivalPosition,
      bestSellerPosition: data.bestSellerPosition,
      hasVariants: false,
    };

    let product;
    if (existing) {
      // Update base + replace images + replace categories
      product = await prisma.product.update({ where: { id: existing.id }, data: productData });
      await prisma.productImage.deleteMany({ where: { productId: existing.id } });
      await prisma.productCategory.deleteMany({ where: { productId: existing.id } });
    } else {
      product = await prisma.product.create({ data: productData });
    }

    // Images
    await prisma.productImage.createMany({
      data: data.images.map((url, i) => ({
        productId: product.id,
        url,
        alt: data.name,
        position: i,
      })),
    });

    // Category link
    const catId = catMap.get(data.category);
    if (catId) {
      await prisma.productCategory.create({ data: { productId: product.id, categoryId: catId } });
    }

    return product;
  }

  // ── Helper: upsert a variant product ─────────────────────────────────────
  async function upsertVariantProduct(
    base: {
      name: string;
      nameAr: string;
      description: string;
      descriptionAr: string;
      sku: string;
      category: string;
      price: number;
      compareAtPrice: number | null;
      status: 'active' | 'draft' | 'archived';
      featured: boolean;
      isNew: boolean;
      isBestSeller: boolean;
      newArrivalPosition: number;
      bestSellerPosition: number;
      images: string[];
    },
    optionsDef: Array<{
      name: string;
      nameAr: string;
      values: Array<{ value: string; valueAr: string }>;
    }>,
    variantsDef: Array<{
      // Index into optionsDef[i].values[j] for each option dimension
      valueIndexes: number[];
      sku: string;
      price?: number;
      compareAtPrice?: number;
      inventory: number;
      imageUrl?: string;
    }>
  ) {
    // Look up or create the base product
    const existing = await prisma.product.findFirst({
      where: { storeId: store.id, sku: base.sku },
      include: {
        images: true,
        categories: true,
        options: { include: { values: true } },
        variants: { include: { options: true } },
      },
    });

    const productData = {
      storeId: store.id,
      name: base.name,
      nameAr: base.nameAr,
      slug: slug(base.name),
      description: base.description,
      descriptionAr: base.descriptionAr,
      sku: base.sku,
      price: base.price,
      compareAtPrice: base.compareAtPrice ?? null,
      inventory: 0, // stock lives on variants
      status: base.status,
      featured: base.featured,
      isNew: base.isNew,
      isBestSeller: base.isBestSeller,
      newArrivalPosition: base.newArrivalPosition,
      bestSellerPosition: base.bestSellerPosition,
      hasVariants: true,
    };

    let product;
    if (existing) {
      // Wipe variants + options + images + categories, then recreate
      await prisma.productVariant.deleteMany({ where: { productId: existing.id } });
      await prisma.productOption.deleteMany({ where: { productId: existing.id } });
      await prisma.productImage.deleteMany({ where: { productId: existing.id } });
      await prisma.productCategory.deleteMany({ where: { productId: existing.id } });
      product = await prisma.product.update({ where: { id: existing.id }, data: productData });
    } else {
      product = await prisma.product.create({ data: productData });
    }

    // Images (primary product images)
    await prisma.productImage.createMany({
      data: base.images.map((url, i) => ({
        productId: product.id,
        url,
        alt: base.name,
        position: i,
      })),
    });

    // Category link
    const catId = catMap.get(base.category);
    if (catId) {
      await prisma.productCategory.create({ data: { productId: product.id, categoryId: catId } });
    }

    // Options + values
    const optionValueIds: string[][] = []; // [optionIndex][valueIndex] → valueId
    for (let oi = 0; oi < optionsDef.length; oi++) {
      const optDef = optionsDef[oi];
      const option = await prisma.productOption.create({
        data: {
          productId: product.id,
          name: optDef.name,
          nameAr: optDef.nameAr,
          position: oi,
          values: {
            create: optDef.values.map((v, vi) => ({
              value: v.value,
              valueAr: v.valueAr,
              position: vi,
            })),
          },
        },
        include: { values: { orderBy: { position: 'asc' } } },
      });
      optionValueIds.push(option.values.map(v => v.id));
    }

    // Variants
    for (let vi = 0; vi < variantsDef.length; vi++) {
      const vd = variantsDef[vi];
      // Collect the specific valueId for each option dimension
      const valueIdsForVariant = vd.valueIndexes.map(
        (valIdx, optIdx) => optionValueIds[optIdx][valIdx]
      );
      // Build title from value labels
      const titleParts = vd.valueIndexes.map(
        (valIdx, optIdx) => optionsDef[optIdx].values[valIdx].value
      );
      const titleArParts = vd.valueIndexes.map(
        (valIdx, optIdx) => optionsDef[optIdx].values[valIdx].valueAr
      );
      const title = titleParts.join(' / ');
      const titleAr = titleArParts.join(' / ');

      await prisma.productVariant.create({
        data: {
          productId: product.id,
          title,
          titleAr,
          sku: vd.sku,
          price: vd.price ?? base.price,
          compareAtPrice: vd.compareAtPrice ?? base.compareAtPrice ?? null,
          inventory: vd.inventory,
          imageUrl: vd.imageUrl ?? null,
          position: vi,
          isActive: true,
          options: {
            create: valueIdsForVariant.map(valueId => ({ valueId })),
          },
        },
      });
    }

    return product;
  }

  // 5. Products
  console.log('\n[4/7] Seeding products…');
  const createdProducts: Array<{ id: string; name: string; price: number }> = [];

  // — Shape 1: Simple products —
  for (const p of PRODUCTS_SIMPLE) {
    const prod = await upsertSimpleProduct(p);
    createdProducts.push({ id: prod.id, name: prod.name, price: prod.price });
  }

  // — Shape 2: 1 option = Size (S / M / L) —
  const sizeProd = await upsertVariantProduct(
    {
      name: 'Classic Crew-Neck Sweatshirt',
      nameAr: 'سويت شيرت كلاسيكي بياقة دائرية',
      description:
        'Premium heavyweight fleece sweatshirt in a relaxed fit. Brushed interior, ribbed cuffs.',
      descriptionAr:
        'سويت شيرت من الفليس الثقيل الفاخر بقصة مريحة. بطانة داخلية معمولة بالفرش وأكمام مضلعة.',
      sku: 'DEMO-SWTR-BASE',
      category: 'Fashion',
      price: fils(14),
      compareAtPrice: fils(19),
      status: 'active',
      featured: true,
      isNew: true,
      isBestSeller: false,
      newArrivalPosition: 2,
      bestSellerPosition: 0,
      images: [
        'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800',
        'https://images.unsplash.com/photo-1556821840-3a63f15732ce?w=800',
      ],
    },
    [
      {
        name: 'Size',
        nameAr: 'المقاس',
        values: [
          { value: 'Small', valueAr: 'صغير' },
          { value: 'Medium', valueAr: 'وسط' },
          { value: 'Large', valueAr: 'كبير' },
        ],
      },
    ],
    [
      {
        valueIndexes: [0],
        sku: 'DEMO-SWTR-S',
        price: fils(13),
        inventory: 20,
        imageUrl: 'https://images.unsplash.com/photo-1542272604-787c3835535d?w=600',
      },
      { valueIndexes: [1], sku: 'DEMO-SWTR-M', price: fils(14), inventory: 35 },
      { valueIndexes: [2], sku: 'DEMO-SWTR-L', price: fils(15), inventory: 0 }, // out of stock
    ]
  );
  createdProducts.push({ id: sizeProd.id, name: sizeProd.name, price: sizeProd.price });

  // — Shape 3: 1 option = Color (Midnight Black / Pearl White / Desert Rose) —
  const colorProd = await upsertVariantProduct(
    {
      name: 'Slim-Fit Linen Shirt',
      nameAr: 'قميص كتان بقصة ضيقة',
      description:
        'Breathable 100% linen shirt, perfect for warm weather. Relaxed collar, pearl buttons.',
      descriptionAr: 'قميص كتان 100٪ مريح، مثالي للطقس الحار. ياقة مريحة وأزرار لؤلؤية.',
      sku: 'DEMO-LINEN-BASE',
      category: 'Fashion',
      price: fils(18),
      compareAtPrice: null,
      status: 'active',
      featured: false,
      isNew: false,
      isBestSeller: true,
      newArrivalPosition: 0,
      bestSellerPosition: 6,
      images: ['https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=800'],
    },
    [
      {
        name: 'Color',
        nameAr: 'اللون',
        values: [
          { value: 'Midnight Black', valueAr: 'أسود داكن' },
          { value: 'Pearl White', valueAr: 'أبيض لؤلؤي' },
          { value: 'Desert Rose', valueAr: 'وردة صحراوية' },
        ],
      },
    ],
    [
      {
        valueIndexes: [0],
        sku: 'DEMO-LINEN-BLK',
        inventory: 18,
        imageUrl: 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?w=600',
      },
      {
        valueIndexes: [1],
        sku: 'DEMO-LINEN-WHT',
        inventory: 24,
        imageUrl: 'https://images.unsplash.com/photo-1621072156002-e2fccdc0b176?w=600',
      },
      {
        valueIndexes: [2],
        sku: 'DEMO-LINEN-RSE',
        inventory: 12,
        compareAtPrice: fils(22), // this colour on sale
        imageUrl: 'https://images.unsplash.com/photo-1562157873-818bc0726f68?w=600',
      },
    ]
  );
  createdProducts.push({ id: colorProd.id, name: colorProd.name, price: colorProd.price });

  // — Shape 4: 2 options = Size × Color → 3×3 = 9 variants —
  const sizes2 = [
    { value: 'S', valueAr: 'S' },
    { value: 'M', valueAr: 'M' },
    { value: 'L', valueAr: 'L' },
  ];
  const colors2 = [
    { value: 'Navy', valueAr: 'كحلي' },
    { value: 'Black', valueAr: 'أسود' },
    { value: 'Khaki', valueAr: 'كاكي' },
  ];

  const variantMatrix9: Array<{
    valueIndexes: number[];
    sku: string;
    price: number;
    inventory: number;
    imageUrl?: string;
  }> = [];
  const baseImages4 = [
    'https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=600',
    'https://images.unsplash.com/photo-1604176354204-9268737828e4?w=600',
    'https://images.unsplash.com/photo-1606107557195-0e29a4b5b4aa?w=600',
  ];
  for (let si = 0; si < sizes2.length; si++) {
    for (let ci = 0; ci < colors2.length; ci++) {
      const inventory = si === 0 && ci === 1 ? 0 : Math.floor(Math.random() * 30) + 5; // Black S = OOS
      variantMatrix9.push({
        valueIndexes: [si, ci],
        sku: `DEMO-CARGO-${sizes2[si].value}-${colors2[ci].value.toUpperCase()}`,
        price: fils(22 + si * 2), // S=22, M=24, L=26
        inventory,
        imageUrl: baseImages4[ci],
      });
    }
  }

  const sizeColorProd = await upsertVariantProduct(
    {
      name: 'Tactical Cargo Trousers',
      nameAr: 'بنطلون كارغو تاكتيكال',
      description:
        'Multi-pocket cargo trousers in durable ripstop fabric. Available in 3 sizes × 3 colours — 9 combinations.',
      descriptionAr:
        'بنطلون كارغو متعدد الجيوب من قماش ريبستوب المتين. متاح بـ 3 مقاسات × 3 ألوان — 9 تركيبات.',
      sku: 'DEMO-CARGO-BASE',
      category: 'Fashion',
      price: fils(22),
      compareAtPrice: fils(28),
      status: 'active',
      featured: true,
      isNew: false,
      isBestSeller: false,
      newArrivalPosition: 0,
      bestSellerPosition: 0,
      images: [
        'https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=800',
        'https://images.unsplash.com/photo-1604176354204-9268737828e4?w=800',
      ],
    },
    [
      { name: 'Size', nameAr: 'المقاس', values: sizes2 },
      { name: 'Color', nameAr: 'اللون', values: colors2 },
    ],
    variantMatrix9
  );
  createdProducts.push({
    id: sizeColorProd.id,
    name: sizeColorProd.name,
    price: sizeColorProd.price,
  });

  // — Shape 5: 3 options = Size × Color × Material → 2×2×2 = 8 variants
  //   (Schema cap confirmed = 3 options from variant.service.ts line 121)
  const sizes3 = [
    { value: 'One Size', valueAr: 'مقاس واحد' },
    { value: 'XL', valueAr: 'XL' },
  ];
  const colors3 = [
    { value: 'Brown', valueAr: 'بني' },
    { value: 'Black', valueAr: 'أسود' },
  ];
  const materials3 = [
    { value: 'Full Grain Leather', valueAr: 'جلد كامل الحبوب' },
    { value: 'Vegan Leather', valueAr: 'جلد نباتي' },
  ];

  const variantMatrix8: Array<{
    valueIndexes: number[];
    sku: string;
    price: number;
    compareAtPrice?: number;
    inventory: number;
    imageUrl?: string;
  }> = [];
  const imgsBag = [
    'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=600',
    'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600',
  ];
  for (let si = 0; si < sizes3.length; si++) {
    for (let ci = 0; ci < colors3.length; ci++) {
      for (let mi = 0; mi < materials3.length; mi++) {
        const priceKwd = 35 + si * 5 + mi * 8; // full-grain = +8
        variantMatrix8.push({
          valueIndexes: [si, ci, mi],
          sku: `DEMO-BAG-${sizes3[si].value.replace(/\s/g, '')}-${colors3[ci].value.toUpperCase()}-${mi === 0 ? 'FGL' : 'VGN'}`,
          price: fils(priceKwd),
          compareAtPrice: mi === 0 ? fils(priceKwd + 10) : undefined, // full-grain on sale
          inventory: ci === 1 && mi === 1 ? 3 : Math.floor(Math.random() * 12) + 2,
          imageUrl: imgsBag[ci],
        });
      }
    }
  }

  const threeProd = await upsertVariantProduct(
    {
      name: 'Artisan Leather Tote Bag',
      nameAr: 'حقيبة توت جلدية حرفية',
      description:
        'Handcrafted tote bag available in 3 option axes: Size × Color × Material (8 combinations). Brass hardware, interior zip pocket.',
      descriptionAr:
        'حقيبة توت مصنوعة يدوياً متاحة بـ 3 محاور خيارات: المقاس × اللون × المادة (8 تركيبات). تشكيلات من النحاس الأصفر وجيب داخلي بسحاب.',
      sku: 'DEMO-BAG-BASE',
      category: 'Fashion',
      price: fils(35),
      compareAtPrice: fils(50),
      status: 'active',
      featured: true,
      isNew: false,
      isBestSeller: true,
      newArrivalPosition: 0,
      bestSellerPosition: 7,
      images: [
        'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=800',
        'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800',
      ],
    },
    [
      { name: 'Size', nameAr: 'المقاس', values: sizes3 },
      { name: 'Color', nameAr: 'اللون', values: colors3 },
      { name: 'Material', nameAr: 'المادة', values: materials3 },
    ],
    variantMatrix8
  );
  createdProducts.push({ id: threeProd.id, name: threeProd.name, price: threeProd.price });

  // A few extra simple products to reach ~25 total
  const extras = [
    {
      shape: 'simple' as const,
      name: 'Stainless Steel Water Bottle',
      nameAr: 'قارورة ماء من الفولاذ المقاوم للصدأ',
      description: 'Double-wall insulated 1L bottle. Keeps drinks cold 24h / hot 12h.',
      descriptionAr:
        'قارورة 1 لتر معزولة بجدارين. تحافظ على برودة المشروبات 24 ساعة / السخونة 12 ساعة.',
      sku: 'DEMO-BOTTLE-001',
      category: 'Sports & Outdoors',
      price: fils(8.5),
      compareAtPrice: fils(12),
      inventory: 55,
      status: 'active' as const,
      featured: false,
      isNew: true,
      isBestSeller: false,
      newArrivalPosition: 4,
      bestSellerPosition: 0,
      images: ['https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=800'],
    },
    {
      shape: 'simple' as const,
      name: 'Premium Date & Nut Gift Hamper',
      nameAr: 'سلة هدايا التمر والمكسرات الفاخرة',
      description:
        'A luxurious gift hamper featuring Medjool dates, mixed nuts, and artisan chocolate. Perfect for corporate gifting.',
      descriptionAr:
        'سلة هدايا فاخرة تضم تمر المجدول والمكسرات المشكلة والشوكولاتة الحرفية. مثالية للهدايا المؤسسية.',
      sku: 'DEMO-HAMPER-001',
      category: 'Food & Gourmet',
      price: fils(42),
      compareAtPrice: null,
      inventory: 8,
      status: 'active' as const,
      featured: true,
      isNew: false,
      isBestSeller: false,
      newArrivalPosition: 0,
      bestSellerPosition: 0,
      images: ['https://images.unsplash.com/photo-1606914858775-9a8aec3c5ac7?w=800'],
    },
    {
      shape: 'simple' as const,
      name: 'Smart Home Hub',
      nameAr: 'مركز المنزل الذكي',
      description:
        'Voice-controlled smart hub compatible with 100+ smart home devices. Wi-Fi + Zigbee.',
      descriptionAr: 'مركز ذكي يعمل بالصوت ومتوافق مع أكثر من 100 جهاز منزل ذكي. Wi-Fi + Zigbee.',
      sku: 'DEMO-SMHUB-001',
      category: 'Electronics',
      price: fils(38),
      compareAtPrice: fils(50),
      inventory: 14,
      status: 'active' as const,
      featured: false,
      isNew: true,
      isBestSeller: false,
      newArrivalPosition: 6,
      bestSellerPosition: 0,
      images: ['https://images.unsplash.com/photo-1558089687-f282ffcbc126?w=800'],
    },
    {
      shape: 'simple' as const,
      name: 'Wall-Mounted Planter Set',
      nameAr: 'طقم أصص معلقة على الجدار',
      description:
        'Set of 3 geometric metal planters with invisible wall mounts. Powder-coated finish.',
      descriptionAr: 'طقم من 3 أصص معدنية هندسية مع تثبيتات جدارية غير مرئية. طلاء بودرة مقاوم.',
      sku: 'DEMO-PLNTR-001',
      category: 'Home & Living',
      price: fils(16),
      compareAtPrice: null,
      inventory: 30,
      status: 'active' as const,
      featured: false,
      isNew: false,
      isBestSeller: false,
      newArrivalPosition: 0,
      bestSellerPosition: 0,
      images: ['https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800'],
    },
    {
      shape: 'simple' as const,
      name: 'Resistance Band Set',
      nameAr: 'طقم أشرطة المقاومة',
      description:
        '5-piece resistance band set (5–35 lbs) with door anchor, handles, ankle straps.',
      descriptionAr: 'طقم من 5 أشرطة مقاومة (5-35 رطل) مع مثبت باب ومقابض وأشرطة كاحل.',
      sku: 'DEMO-BANDS-001',
      category: 'Sports & Outdoors',
      price: fils(6.5),
      compareAtPrice: null,
      inventory: 70,
      status: 'active' as const,
      featured: false,
      isNew: false,
      isBestSeller: false,
      newArrivalPosition: 0,
      bestSellerPosition: 0,
      images: ['https://images.unsplash.com/photo-1571902943202-507ec2618e8f?w=800'],
    },
    {
      shape: 'simple' as const,
      name: 'Vitamin C + Zinc Supplement',
      nameAr: 'مكمل فيتامين C + الزنك',
      description: 'High-potency immune support — 1000mg Vitamin C + 15mg Zinc. 60 capsules.',
      descriptionAr: 'دعم مناعي عالي الفاعلية — 1000 مجم فيتامين C + 15 مجم زنك. 60 كبسولة.',
      sku: 'DEMO-VIT-001',
      category: 'Beauty & Wellness',
      price: fils(5.5),
      compareAtPrice: fils(7),
      inventory: 120,
      status: 'active' as const,
      featured: false,
      isNew: false,
      isBestSeller: false,
      newArrivalPosition: 0,
      bestSellerPosition: 0,
      images: ['https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800'],
    },
    {
      shape: 'simple' as const,
      name: 'Artisan Cold Brew Kit',
      nameAr: 'طقم القهوة الباردة الحرفية',
      description:
        '1.5L cold brew jar with fine-mesh filter. Brews in 12–24 hours. Glass + BPA-free.',
      descriptionAr:
        'جرة تخمير بارد 1.5 لتر مع مرشح شبكي ناعم. يُخمر في 12-24 ساعة. زجاج وخالٍ من BPA.',
      sku: 'DEMO-CBREW-001',
      category: 'Food & Gourmet',
      price: fils(14.5),
      compareAtPrice: null,
      inventory: 25,
      status: 'active' as const,
      featured: false,
      isNew: true,
      isBestSeller: false,
      newArrivalPosition: 7,
      bestSellerPosition: 0,
      images: ['https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800'],
    },
  ];

  for (const p of extras) {
    const prod = await upsertSimpleProduct(p);
    createdProducts.push({ id: prod.id, name: prod.name, price: prod.price });
  }

  console.log(`  ✓ ${createdProducts.length} products total`);
  console.log(
    `    Shape 1 (simple):            ${PRODUCTS_SIMPLE.length + extras.length} products`
  );
  console.log('    Shape 2 (1 option: Size):    1 product, 3 variants');
  console.log('    Shape 3 (1 option: Color):   1 product, 3 variants');
  console.log('    Shape 4 (2 options: S×C):    1 product, 9 variants');
  console.log('    Shape 5 (3 options: S×C×M):  1 product, 8 variants');

  // 6. Customers + Orders + Reviews + Loyalty
  console.log('\n[5/7] Seeding customers…');

  // Clear existing orders/reviews/loyalty for this store first
  // (Order cascade removes order items and loyalty transactions)
  await prisma.review.deleteMany({ where: { storeId: store.id } });
  await prisma.loyaltyTransaction.deleteMany({ where: { storeId: store.id } });
  await prisma.loyaltyPoints.deleteMany({ where: { storeId: store.id } });
  await prisma.order.deleteMany({ where: { storeId: store.id } });
  await prisma.customer.deleteMany({ where: { storeId: store.id } });

  const createdCustomers: Array<(typeof CUSTOMERS)[number] & { id: string }> = [];
  for (const c of CUSTOMERS) {
    const cust = await prisma.customer.create({
      data: {
        storeId: store.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        totalOrders: 0,
        totalSpent: 0,
      },
    });
    createdCustomers.push({ ...c, id: cust.id });
  }
  console.log(`  ✓ ${createdCustomers.length} customers`);

  // — Orders spanning every status —
  console.log('\n[6/7] Seeding orders + reviews…');

  const orderStatuses = [
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
  ] as const;
  const paymentStatuses = ['unpaid', 'paid', 'paid', 'paid', 'paid', 'unpaid', 'refunded'] as const; // mirrors the order statuses above

  const orderNumbers: string[] = [];

  for (let i = 0; i < 15; i++) {
    const cust = createdCustomers[i % createdCustomers.length];
    const statusIdx = i % orderStatuses.length;
    const orderStatus = orderStatuses[statusIdx];
    const paymentStatus = paymentStatuses[statusIdx];
    const isCod = i % 3 === 0; // every 3rd order is COD

    // Pick 1–3 products for this order
    const orderProducts = createdProducts
      .slice((i * 2) % createdProducts.length, ((i * 2) % createdProducts.length) + ((i % 3) + 1))
      .slice(0, 3);
    if (orderProducts.length === 0) orderProducts.push(createdProducts[0]);

    const subtotal = orderProducts.reduce((s, p) => s + p.price * ((i % 2) + 1), 0);
    const shipping = fils(1.5);
    const total = subtotal + shipping;
    const orderNumber = `DEMO-${String(1000 + i + 1).padStart(4, '0')}`;
    orderNumbers.push(orderNumber);

    const deliveredAt =
      orderStatus === 'delivered' ? new Date(Date.now() - 1000 * 60 * 60 * 24 * (i + 1)) : null;
    const shippedAt = ['shipped', 'delivered'].includes(orderStatus)
      ? new Date(Date.now() - 1000 * 60 * 60 * 24 * (i + 2))
      : null;

    const order = await prisma.order.create({
      data: {
        storeId: store.id,
        orderNumber,
        status: orderStatus,
        paymentStatus,
        subtotal,
        shipping,
        tax: 0,
        discount: 0,
        total,
        currency: 'KWD',
        shippingAddress: address(cust.firstName, cust.lastName),
        billingAddress: address(cust.firstName, cust.lastName),
        notes: isCod ? 'Cash on delivery — ring the bell' : null,
        locale: i % 2 === 0 ? 'en' : 'ar',
        deliveredAt,
        shippedAt,
        items: {
          create: orderProducts.map(p => ({
            productId: p.id,
            productName: p.name,
            quantity: (i % 2) + 1,
            price: p.price,
            total: p.price * ((i % 2) + 1),
          })),
        },
      },
    });

    // Payment row for online orders
    if (!isCod && paymentStatus !== 'unpaid') {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: i % 2 === 0 ? 'tap' : 'myfatoorah',
          method: i % 3 === 0 ? 'knet' : 'visa',
          status: paymentStatus === 'refunded' ? 'refunded' : 'completed',
          amount: total,
          currency: 'KWD',
          transactionId: `DEMO-TXN-${order.id.slice(0, 8)}`,
          paidAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * i),
        },
      });
    }

    // Update customer totals
    await prisma.customer.update({
      where: { id: cust.id },
      data: {
        totalOrders: { increment: 1 },
        totalSpent: { increment: total },
      },
    });

    // Reviews for delivered orders
    if (orderStatus === 'delivered' && orderProducts.length > 0) {
      const reviewProduct = orderProducts[0];
      const rating = [4, 5, 5, 3, 5, 4, 5][i % 7];
      const bodies = [
        'Excellent product, exceeded my expectations!',
        'Great quality and fast delivery. Highly recommend.',
        'Very happy with my purchase. Will buy again.',
        'Decent product but shipping took a bit long.',
        'Perfect gift for my family. Beautiful packaging.',
        'Amazing quality — worth every fils!',
        'Fantastic! The product looks exactly like the photos.',
      ];
      const bodiesAr = [
        'منتج ممتاز، تجاوز توقعاتي!',
        'جودة رائعة وتسليم سريع. أنصح به بشدة.',
        'سعيد جداً بشرائي. سأشتري مرة أخرى.',
        'منتج جيد لكن الشحن استغرق وقتاً.',
        'هدية مثالية لعائلتي. تغليف جميل.',
        'جودة مذهلة — يستحق كل فلس!',
        'رائع! المنتج يبدو تماماً كالصور.',
      ];

      await prisma.review.create({
        data: {
          productId: reviewProduct.id,
          storeId: store.id,
          orderId: order.id,
          rating,
          body: bodies[i % bodies.length],
          bodyTranslated: bodiesAr[i % bodiesAr.length],
          language: 'en',
          status: i % 4 === 3 ? 'pending' : 'published', // some pending moderation
          verifiedPurchase: true,
        },
      });
    }
  }

  // Additional reviews to reach ~15 total (some for the variant products)
  const variantProds = [sizeProd, colorProd, sizeColorProd, threeProd];
  for (let i = 0; i < 4; i++) {
    // Create a "stub" order so the review FK is satisfied
    const cust = createdCustomers[i % createdCustomers.length];
    const prodForReview = variantProds[i];
    const stubOrder = await prisma.order.create({
      data: {
        storeId: store.id,
        orderNumber: `DEMO-REV-${String(i + 1).padStart(4, '0')}`,
        status: 'delivered',
        paymentStatus: 'paid',
        subtotal: prodForReview.price,
        shipping: fils(1.5),
        tax: 0,
        discount: 0,
        total: prodForReview.price + fils(1.5),
        currency: 'KWD',
        shippingAddress: address(cust.firstName, cust.lastName),
        billingAddress: address(cust.firstName, cust.lastName),
        deliveredAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * (i + 5)),
        items: {
          create: [
            {
              productId: prodForReview.id,
              productName: prodForReview.name,
              quantity: 1,
              price: prodForReview.price,
              total: prodForReview.price,
            },
          ],
        },
      },
    });
    await prisma.review.create({
      data: {
        productId: prodForReview.id,
        storeId: store.id,
        orderId: stubOrder.id,
        rating: [5, 4, 5, 3][i],
        body: [
          'Perfect fit and great material!',
          'Love the colour options.',
          'Very comfortable, would buy again.',
          'Good quality, but sizing runs large.',
        ][i],
        language: 'en',
        status: 'published',
        verifiedPurchase: true,
      },
    });
  }

  const reviewCount = await prisma.review.count({ where: { storeId: store.id } });
  const orderCount = await prisma.order.count({ where: { storeId: store.id } });
  console.log(`  ✓ ${orderCount} orders`);
  console.log(`  ✓ ${reviewCount} reviews`);

  // — Loyalty: LoyaltyPoints.customerId references a registered User account
  //   (NOT the Customer model). So create demo customer Users + attach points.
  //   Wrapped so a loyalty hiccup never blocks the content enrichment below.
  try {
    const demoPasswordHash = await bcrypt.hash('DemoPass123!', 10);
    for (let i = 0; i < 5; i++) {
      const c = createdCustomers[i];
      const email = `loyal${i + 1}@demo.forcemediakw.com`;
      const u = await prisma.user.upsert({
        where: { storeId_email: { storeId: store.id, email } },
        update: { firstName: c.firstName, lastName: c.lastName },
        create: {
          storeId: store.id,
          email,
          passwordHash: demoPasswordHash,
          firstName: c.firstName,
          lastName: c.lastName,
          role: 'customer',
        },
      });
      const points = (i + 1) * 250;
      const tier = points >= 1000 ? 'gold' : points >= 500 ? 'silver' : 'bronze';
      await prisma.loyaltyPoints.upsert({
        where: { storeId_customerId: { storeId: store.id, customerId: u.id } },
        update: { points, totalEarned: points + 50, totalRedeemed: 50, tier },
        create: {
          storeId: store.id,
          customerId: u.id,
          points,
          totalEarned: points + 50,
          totalRedeemed: 50,
          tier,
        },
      });
      await prisma.loyaltyTransaction.create({
        data: {
          storeId: store.id,
          customerId: u.id,
          type: 'earn_purchase',
          points,
          description: 'Demo purchase bonus points',
        },
      });
    }
    console.log('  ✓ 5 loyalty records (with demo customer accounts)');
  } catch (e) {
    console.warn('  ⚠ loyalty seeding skipped:', (e as Error).message);
  }

  // 7. Coupons
  console.log('\n[7/7] Seeding coupons…');
  await prisma.coupon.deleteMany({ where: { storeId: store.id } });
  const couponExpiry = new Date();
  couponExpiry.setMonth(couponExpiry.getMonth() + 6);

  await prisma.coupon.createMany({
    data: [
      {
        storeId: store.id,
        code: 'WELCOME10',
        name: '10% Welcome Discount',
        nameAr: 'خصم ترحيبي 10٪',
        type: 'percentage',
        value: 10,
        description: '10% off your first order',
        descriptionAr: 'خصم 10٪ على أول طلب',
        usageLimit: 500,
        isActive: true,
        expiresAt: couponExpiry,
      },
      {
        storeId: store.id,
        code: 'SAVE5KD',
        name: 'Save 5 KWD',
        nameAr: 'وفر 5 د.ك',
        type: 'fixed',
        value: fils(5),
        description: '5 KWD off orders over 20 KWD',
        descriptionAr: 'خصم 5 د.ك على الطلبات فوق 20 د.ك',
        minOrderAmount: fils(20),
        isActive: true,
        expiresAt: couponExpiry,
      },
      {
        storeId: store.id,
        code: 'FREESHIP',
        name: 'Free Shipping',
        nameAr: 'شحن مجاني',
        type: 'free_shipping',
        value: 0,
        description: 'Free shipping on any order',
        descriptionAr: 'شحن مجاني على أي طلب',
        isActive: true,
        expiresAt: couponExpiry,
      },
    ],
  });
  console.log('  ✓ 3 coupons');

  // ── 8. Blog posts ─────────────────────────────────────────────────────────
  console.log('\n[8/13] Seeding blog posts…');
  await prisma.blogPost.deleteMany({ where: { storeId: store.id } });

  const BLOG_POSTS = [
    {
      slug: 'demo-welcome-to-force-store',
      title: '5 Reasons to Love Shopping With Us',
      titleAr: '5 أسباب تجعلك تحب التسوق معنا',
      excerpt:
        "From lightning-fast delivery to hassle-free returns — here's what makes Force Demo Store different.",
      excerptAr: 'من التوصيل السريع إلى المرتجعات السهلة — إليك ما يميز متجر فورس التجريبي.',
      content: `<h2>We Put Customers First</h2>
<p>At Force Demo Store, every decision starts with one question: does this make our customers happier? From the moment you land on our homepage to the second your order arrives at your door, we obsess over every detail.</p>
<h2>Lightning-Fast Delivery</h2>
<p>Most orders ship same day when placed before 2 pm. We partner with the best local couriers in Kuwait to make sure your package arrives on time, every time.</p>
<h2>Hassle-Free Returns</h2>
<p>Changed your mind? No problem. We accept returns within 14 days — no questions asked. Just drop us a WhatsApp message and we'll handle the rest.</p>
<h2>Premium Products, Honest Prices</h2>
<p>We source every product carefully, and we never inflate prices. Our goal is to offer you genuine quality at prices that feel fair.</p>
<h2>Bilingual Support</h2>
<p>Our customer support team speaks Arabic and English fluently. Whether you prefer to chat in عربي or English, we've got you covered.</p>`,
      contentAr: `<h2>نضع العملاء في المقام الأول</h2>
<p>في متجر فورس التجريبي، تبدأ كل قرار بسؤال واحد: هل هذا يجعل عملاءنا أكثر سعادة؟ من اللحظة التي تصل فيها إلى صفحتنا الرئيسية حتى وصول طلبك إلى بابك، نهتم بكل تفصيل.</p>
<h2>توصيل سريع كالبرق</h2>
<p>معظم الطلبات تُشحن في نفس اليوم عند الطلب قبل الساعة 2 ظهراً. نتعاون مع أفضل شركات التوصيل المحلية في الكويت.</p>
<h2>إرجاع سهل بدون متاعب</h2>
<p>غيّرت رأيك؟ لا مشكلة. نقبل الإرجاع خلال 14 يوماً — دون أسئلة. فقط أرسل لنا رسالة واتساب وسنتولى الأمر.</p>
<h2>منتجات فاخرة بأسعار صادقة</h2>
<p>نختار كل منتج بعناية، ولا نبالغ أبداً في الأسعار. هدفنا تقديم جودة حقيقية بأسعار عادلة.</p>
<h2>دعم ثنائي اللغة</h2>
<p>فريق دعم العملاء لدينا يتحدث العربية والإنجليزية بطلاقة.</p>`,
      coverImage: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1200&q=80',
      isPublished: true,
      publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
    },
    {
      slug: 'demo-electronics-buying-guide',
      title: 'Your Complete Guide to Buying Electronics Online',
      titleAr: 'دليلك الكامل لشراء الإلكترونيات عبر الإنترنت',
      excerpt:
        'What to look for when buying headphones, speakers, and smart home devices — so you never buy the wrong product again.',
      excerptAr: 'ما الذي تبحث عنه عند شراء سماعات الرأس ومكبرات الصوت وأجهزة المنزل الذكي.',
      content: `<h2>Know Your Budget</h2>
<p>Electronics can range from budget-friendly to premium. Set a realistic budget before you start browsing — it will narrow your choices and save you from buyer's remorse.</p>
<h2>Read the Specs</h2>
<p>For headphones, pay attention to driver size, frequency response, and whether they're open-back or closed-back. For speakers, look at watts, frequency range, and connectivity options (Bluetooth 5.0+ is worth the premium).</p>
<h2>Check Warranty and After-Sales Support</h2>
<p>Always buy from a seller that offers at least a 1-year warranty. Our electronics all come with manufacturer warranties and local support.</p>
<h2>Our Top Picks This Season</h2>
<p>Check out our best-selling <strong>Wireless Noise-Cancelling Headphones</strong> and the ultra-compact <strong>Portable Bluetooth Speaker</strong> — two of our most loved items this month.</p>`,
      contentAr: `<h2>حدّد ميزانيتك</h2>
<p>تتراوح الإلكترونيات بين الاقتصادية والفاخرة. حدد ميزانية واقعية قبل البدء في التصفح.</p>
<h2>اقرأ المواصفات</h2>
<p>لسماعات الرأس، انتبه لحجم المشغّل واستجابة التردد. للمكبرات، انظر إلى الواط ونطاق التردد وخيارات الاتصال.</p>
<h2>تحقق من الضمان ودعم ما بعد البيع</h2>
<p>اشترِ دائماً من بائع يقدم ضماناً لمدة سنة على الأقل. جميع إلكترونياتنا تأتي بضمان الشركة المصنّعة.</p>
<h2>اختياراتنا المفضلة هذا الموسم</h2>
<p>تصفح <strong>سماعات الرأس اللاسلكية بخاصية إلغاء الضوضاء</strong> و<strong>مكبر الصوت البلوتوث المحمول</strong>.</p>`,
      coverImage: 'https://images.unsplash.com/photo-1525547719571-a2d4ac8945e2?w=1200&q=80',
      isPublished: true,
      publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 22),
    },
    {
      slug: 'demo-home-decor-tips',
      title: 'Transform Your Home With These 7 Simple Decor Tips',
      titleAr: '7 نصائح بسيطة لتحويل منزلك',
      excerpt:
        "You don't need a big budget to create a beautiful home. Discover easy, affordable ways to refresh your living space.",
      excerptAr: 'لا تحتاج إلى ميزانية كبيرة لإنشاء منزل جميل. اكتشف طرقاً سهلة وبأسعار معقولة.',
      content: `<h2>Start With a Scent</h2>
<p>Before anything else, make your home smell amazing. Our <strong>Scented Oud Candle</strong> fills a room with authentic Arabian oud fragrance — instantly transforming the mood of any space.</p>
<h2>Add Plants</h2>
<p>Greenery brings life to any room. A well-placed plant (or a set of geometric wall-mounted planters) immediately makes a space feel cared for and vibrant.</p>
<h2>Curate Your Mugs</h2>
<p>The kitchen is the heart of the home. Swap mismatched mugs for a set of artisan ceramic pieces — small change, big impact.</p>
<h2>Light Matters</h2>
<p>Natural light is free. Pull back curtains, add a mirror to bounce light around, and use warm-toned bulbs for evenings.</p>`,
      contentAr: `<h2>ابدأ بالرائحة</h2>
<p>قبل أي شيء آخر، اجعل منزلك يفوح برائحة رائعة. شمعة العود المعطرة تملأ الغرفة بعبير العود العربي الأصيل.</p>
<h2>أضف النباتات</h2>
<p>الخضرة تضفي الحياة على أي غرفة. نبتة في مكان مناسب تجعل المساحة تبدو أكثر حيوية.</p>
<h2>اختر أكوابك بعناية</h2>
<p>المطبخ هو قلب المنزل. استبدل الأكواب غير المتناسقة بطقم من السيراميك الحرفي — تغيير صغير، أثر كبير.</p>
<h2>الإضاءة مهمة</h2>
<p>الضوء الطبيعي مجاني. اسحب الستائر وأضف مرآة لتوزيع الضوء.</p>`,
      coverImage: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=1200&q=80',
      isPublished: true,
      publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 15),
    },
    {
      slug: 'demo-skincare-routine',
      title: 'Build the Perfect Skincare Routine in 5 Steps',
      titleAr: 'بناء روتين العناية بالبشرة المثالي في 5 خطوات',
      excerpt:
        "Great skin doesn't happen overnight — but a consistent routine makes all the difference. Here's where to start.",
      excerptAr: 'البشرة الرائعة لا تأتي في ليلة واحدة — لكن الروتين المنتظم يحدث فارقاً كبيراً.',
      content: `<h2>Step 1: Cleanse</h2>
<p>Always start with clean skin. Use a gentle cleanser morning and evening to remove dirt, oil, and makeup without stripping moisture.</p>
<h2>Step 2: Tone</h2>
<p>A toner balances your skin's pH and preps it for the rest of your routine. Look for alcohol-free formulas with niacinamide or rose water.</p>
<h2>Step 3: Serum</h2>
<p>This is where targeted treatments happen. Our <strong>Luxury Rose Face Serum</strong> with 5% niacinamide visibly reduces dark spots in as little as 4 weeks.</p>
<h2>Step 4: Moisturise</h2>
<p>Seal everything in with a lightweight moisturiser suited to your skin type. Don't skip this step — even oily skin needs hydration.</p>
<h2>Step 5: SPF (Morning Only)</h2>
<p>UV protection is non-negotiable. Apply an SPF 30+ every single morning, rain or shine.</p>`,
      contentAr: `<h2>الخطوة 1: التنظيف</h2>
<p>ابدأ دائماً ببشرة نظيفة. استخدم منظفاً لطيفاً صباحاً ومساءً.</p>
<h2>الخطوة 2: التونر</h2>
<p>يوازن التونر درجة حموضة بشرتك. ابحث عن التركيبات الخالية من الكحول مع النياسيناميد.</p>
<h2>الخطوة 3: السيروم</h2>
<p>هنا تحدث العلاجات المستهدفة. <strong>سيروم الوجه الفاخر بالورد</strong> مع نياسيناميد 5٪ يقلل البقع الداكنة في 4 أسابيع.</p>
<h2>الخطوة 4: الترطيب</h2>
<p>اختم روتينك بمرطب خفيف مناسب لنوع بشرتك.</p>
<h2>الخطوة 5: واقي الشمس (صباحاً فقط)</h2>
<p>الحماية من الأشعة فوق البنفسجية أمر لا تفاوض عليه.</p>`,
      coverImage: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=1200&q=80',
      isPublished: true,
      publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10),
    },
    {
      slug: 'demo-gift-guide',
      title: 'The Ultimate Gift Guide for Every Occasion',
      titleAr: 'دليل الهدايا الشامل لكل مناسبة',
      excerpt:
        "Struggling to find the perfect gift? We've curated our top picks by occasion — from Eid to birthdays to corporate gifts.",
      excerptAr: 'تجد صعوبة في إيجاد الهدية المثالية؟ جمعنا لك أفضل اختياراتنا لكل مناسبة.',
      content: `<h2>For Eid</h2>
<p>Our <strong>Artisan Honey Gift Box</strong> and <strong>Premium Arabic Oud Perfume</strong> are perennial favourites during Eid celebrations. Both come gift-wrapped on request.</p>
<h2>For Birthdays</h2>
<p>Make someone's day with a <strong>Luxury Rose Face Serum</strong> or a beautiful <strong>Handmade Ceramic Mug Set</strong> — thoughtful, personal, and genuinely useful.</p>
<h2>For Corporate Gifting</h2>
<p>Our <strong>Premium Date & Nut Gift Hamper</strong> is the go-to choice for corporate clients and VIP guests. Bulk ordering available — contact us for custom pricing.</p>
<h2>For the Tech-Lover</h2>
<p>The <strong>Wireless Noise-Cancelling Headphones</strong> or <strong>Smart Home Hub</strong> will delight anyone who loves gadgets and smart living.</p>`,
      contentAr: `<h2>للعيد</h2>
<p><strong>صندوق هدايا العسل الحرفي</strong> و<strong>عطر العود العربي الفاخر</strong> من أكثر الخيارات المفضلة في احتفالات العيد.</p>
<h2>لأعياد الميلاد</h2>
<p>فرّح شخصاً ما بـ<strong>سيروم الوجه الفاخر بالورد</strong> أو <strong>طقم أكواب السيراميك المصنوعة يدوياً</strong>.</p>
<h2>للهدايا المؤسسية</h2>
<p><strong>سلة هدايا التمر والمكسرات الفاخرة</strong> هي الخيار المفضل للعملاء المؤسسيين. الطلب بالجملة متاح.</p>
<h2>لمحبي التقنية</h2>
<p><strong>سماعات الرأس اللاسلكية بخاصية إلغاء الضوضاء</strong> أو <strong>مركز المنزل الذكي</strong> سيسعد أي شخص يحب الأجهزة.</p>`,
      coverImage: 'https://images.unsplash.com/photo-1606914858775-9a8aec3c5ac7?w=1200&q=80',
      isPublished: true,
      publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5),
    },
    {
      slug: 'demo-wellness-tips',
      title: 'Small Daily Habits That Improve Your Wellbeing',
      titleAr: 'عادات يومية صغيرة تحسّن صحتك وعافيتك',
      excerpt:
        'Big results start with small habits. Here are six simple practices to incorporate into your daily routine for lasting wellbeing.',
      excerptAr: 'النتائج الكبيرة تبدأ بعادات صغيرة. إليك ست ممارسات بسيطة لصحة دائمة.',
      content: `<h2>Move for 20 Minutes</h2>
<p>You don't need a gym. A yoga mat, a resistance band set, and 20 minutes a day is all it takes to build a meaningful movement habit.</p>
<h2>Hydrate Consistently</h2>
<p>Most people are mildly dehydrated without knowing it. Carry a quality water bottle — our <strong>Stainless Steel Water Bottle</strong> keeps drinks cold for 24 hours — and aim for 8 glasses a day.</p>
<h2>Supplement Smartly</h2>
<p>A daily <strong>Vitamin C + Zinc supplement</strong> supports your immune system year-round. Simple, affordable, and backed by decades of research.</p>
<h2>Invest in Quality Sleep</h2>
<p>A consistent sleep schedule beats any supplement. Dark curtains, a cool room, and no screens 30 minutes before bed make a dramatic difference.</p>
<h2>Enjoy a Ritual</h2>
<p>Create a morning or evening ritual — something you genuinely look forward to. A quality coffee brewed in your <strong>Artisan Cold Brew Kit</strong> or lighting a calming scented candle both count.</p>`,
      contentAr: `<h2>تحرك 20 دقيقة يومياً</h2>
<p>لا تحتاج إلى صالة رياضية. حصيرة يوغا وأشرطة مقاومة و20 دقيقة يومياً كافية.</p>
<h2>اشرب الماء باستمرار</h2>
<p>معظم الناس يعانون من الجفاف الخفيف دون أن يعلموا. احمل <strong>قارورة الماء من الفولاذ المقاوم للصدأ</strong>.</p>
<h2>تناول المكملات بذكاء</h2>
<p><strong>مكمل فيتامين C + الزنك</strong> اليومي يدعم جهازك المناعي طوال العام.</p>
<h2>استثمر في نوم جيد</h2>
<p>جدول النوم المنتظم أفضل من أي مكمل غذائي.</p>
<h2>استمتع بطقس يومي</h2>
<p>أنشئ طقساً صباحياً أو مسائياً — شيئاً تتطلع إليه حقاً. قهوة باردة من <strong>طقم القهوة الباردة الحرفية</strong> أو إشعال شمعة معطرة.</p>`,
      coverImage: 'https://images.unsplash.com/photo-1601925228208-8cee93ef6e6e?w=1200&q=80',
      isPublished: true,
      publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2),
    },
  ];

  for (const post of BLOG_POSTS) {
    await prisma.blogPost.create({
      data: {
        storeId: store.id,
        ...post,
      },
    });
  }
  console.log(`  ✓ ${BLOG_POSTS.length} blog posts`);

  // ── 9. Store pages — About, Contact, FAQ page, Privacy, Terms, Shipping ──
  console.log('\n[9/13] Seeding store pages…');
  await prisma.storePage.deleteMany({ where: { storeId: store.id } });

  const STORE_PAGES = [
    {
      slug: 'about',
      title: 'About Us',
      titleAr: 'من نحن',
      isPublished: true,
      position: 0,
      coverImage: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=1400&q=80',
      contentBlocks: [
        {
          type: 'heading',
          text: 'Our Story',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'Force Demo Store was founded with a single mission: to bring premium products to Kuwait at prices that feel fair. We believe that quality should be accessible — not a luxury reserved for the few.',
        },
        {
          type: 'paragraph',
          text: 'From our headquarters in Kuwait City, our team carefully curates every product we sell. We work directly with manufacturers and trusted distributors to cut out the middlemen and pass the savings on to you.',
        },
        {
          type: 'heading',
          text: 'Our Values',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'Quality, honesty, and exceptional service define everything we do. We stand behind every product we sell and make returns effortless. Our support team is available 7 days a week via WhatsApp and email.',
        },
      ],
      contentBlocksAr: [
        {
          type: 'heading',
          text: 'قصتنا',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'تأسس متجر فورس التجريبي بمهمة واحدة: تقديم منتجات فاخرة للكويت بأسعار عادلة. نؤمن بأن الجودة يجب أن تكون في متناول الجميع.',
        },
        {
          type: 'paragraph',
          text: 'من مقرنا في مدينة الكويت، يختار فريقنا بعناية كل منتج نبيعه. نعمل مباشرة مع المصنّعين والموزعين الموثوقين.',
        },
        {
          type: 'heading',
          text: 'قيمنا',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'الجودة والصدق والخدمة الاستثنائية تحدد كل ما نفعله. فريق الدعم لدينا متاح 7 أيام في الأسبوع عبر واتساب والبريد الإلكتروني.',
        },
      ],
    },
    {
      slug: 'contact',
      title: 'Contact Us',
      titleAr: 'تواصل معنا',
      isPublished: true,
      position: 1,
      contentBlocks: [
        {
          type: 'heading',
          text: 'Get in Touch',
          level: 2,
        },
        {
          type: 'paragraph',
          text: "We'd love to hear from you. Whether you have a question about a product, an order, or just want to say hello — our team is ready to help.",
        },
        {
          type: 'heading',
          text: 'Contact Details',
          level: 3,
        },
        {
          type: 'paragraph',
          text: 'WhatsApp: +965 9999 0000\nEmail: demo@forcemediakw.com\nAddress: Kuwait City, Kuwait\nWorking Hours: Saturday – Thursday, 9 am – 9 pm',
        },
        {
          type: 'heading',
          text: 'Order Support',
          level: 3,
        },
        {
          type: 'paragraph',
          text: 'For the fastest response on an existing order, message us on WhatsApp with your order number. We reply within 30 minutes during working hours.',
        },
      ],
      contentBlocksAr: [
        {
          type: 'heading',
          text: 'تواصل معنا',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'يسعدنا سماع منك. سواء كان لديك سؤال عن منتج أو طلب أو فقط تريد أن تتحدث — فريقنا جاهز للمساعدة.',
        },
        {
          type: 'heading',
          text: 'بياناتنا',
          level: 3,
        },
        {
          type: 'paragraph',
          text: 'واتساب: ‎+965 9999 0000\nالبريد الإلكتروني: demo@forcemediakw.com\nالعنوان: مدينة الكويت، الكويت\nساعات العمل: السبت – الخميس، 9 صباحاً – 9 مساءً',
        },
        {
          type: 'heading',
          text: 'دعم الطلبات',
          level: 3,
        },
        {
          type: 'paragraph',
          text: 'للحصول على أسرع رد بشأن طلب موجود، راسلنا على واتساب مع رقم طلبك. نرد خلال 30 دقيقة خلال ساعات العمل.',
        },
      ],
    },
    {
      slug: 'shipping',
      title: 'Shipping & Delivery',
      titleAr: 'الشحن والتوصيل',
      isPublished: true,
      position: 2,
      contentBlocks: [
        {
          type: 'heading',
          text: 'Delivery Within Kuwait',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'We deliver across all Kuwait governorates. Standard delivery takes 1–2 business days. Same-day delivery is available for orders placed before 12 pm (selected areas).',
        },
        {
          type: 'heading',
          text: 'Shipping Fees',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'Standard shipping: 1.5 KWD\nFree shipping on orders over 10 KWD\nUse coupon code FREESHIP for free shipping on any order.',
        },
        {
          type: 'heading',
          text: 'Order Tracking',
          level: 2,
        },
        {
          type: 'paragraph',
          text: "You'll receive a WhatsApp notification when your order ships, including a tracking link. You can also track your order in real time from your account page.",
        },
      ],
      contentBlocksAr: [
        {
          type: 'heading',
          text: 'التوصيل داخل الكويت',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'نوصّل إلى جميع محافظات الكويت. يستغرق التوصيل العادي 1-2 أيام عمل. التوصيل في نفس اليوم متاح للطلبات قبل الساعة 12 ظهراً (مناطق مختارة).',
        },
        {
          type: 'heading',
          text: 'رسوم الشحن',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'الشحن العادي: 1.5 د.ك\nشحن مجاني للطلبات فوق 10 د.ك\nاستخدم كود FREESHIP للشحن المجاني على أي طلب.',
        },
        {
          type: 'heading',
          text: 'تتبع الطلب',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'ستتلقى إشعاراً على واتساب عند شحن طلبك مع رابط التتبع. يمكنك أيضاً تتبع طلبك في الوقت الفعلي من صفحة حسابك.',
        },
      ],
    },
    {
      slug: 'returns',
      title: 'Returns & Refunds',
      titleAr: 'الإرجاع والاسترداد',
      isPublished: true,
      position: 3,
      contentBlocks: [
        {
          type: 'heading',
          text: 'Our Return Policy',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'We accept returns within 14 days of delivery for most items. Products must be unused, in their original packaging, and accompanied by the original receipt.',
        },
        {
          type: 'heading',
          text: 'How to Return',
          level: 2,
        },
        {
          type: 'paragraph',
          text: "1. Message us on WhatsApp with your order number and the item you wish to return.\n2. We'll arrange a pickup from your address at no extra cost.\n3. Your refund will be processed within 3–5 business days once we receive the item.",
        },
        {
          type: 'heading',
          text: 'Exceptions',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'The following items are non-returnable: opened food and beverages, used skincare products, and items damaged after delivery. Sale items may be subject to a restocking fee.',
        },
      ],
      contentBlocksAr: [
        {
          type: 'heading',
          text: 'سياسة الإرجاع',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'نقبل الإرجاع خلال 14 يوماً من التسليم لمعظم العناصر. يجب أن تكون المنتجات غير مستخدمة في عبواتها الأصلية.',
        },
        {
          type: 'heading',
          text: 'كيفية الإرجاع',
          level: 2,
        },
        {
          type: 'paragraph',
          text: '1. راسلنا على واتساب برقم طلبك والعنصر الذي تريد إرجاعه.\n2. سنرتب الاستلام من عنوانك بدون تكلفة إضافية.\n3. سيتم معالجة استردادك خلال 3-5 أيام عمل.',
        },
        {
          type: 'heading',
          text: 'الاستثناءات',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'العناصر التالية غير قابلة للإرجاع: الأغذية والمشروبات المفتوحة، ومنتجات العناية بالبشرة المستخدمة.',
        },
      ],
    },
    {
      slug: 'privacy',
      title: 'Privacy Policy',
      titleAr: 'سياسة الخصوصية',
      isPublished: true,
      position: 4,
      contentBlocks: [
        {
          type: 'heading',
          text: 'Privacy Policy',
          level: 1,
        },
        {
          type: 'paragraph',
          text: 'Force Demo Store is committed to protecting your privacy. This policy explains what information we collect, how we use it, and your rights regarding your data.',
        },
        {
          type: 'heading',
          text: 'What We Collect',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'We collect: your name and contact details (to process orders), delivery address, payment information (processed securely by our payment provider — we never store card details), and order history.',
        },
        {
          type: 'heading',
          text: 'How We Use Your Data',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'We use your data to process and deliver your orders, send order status notifications via WhatsApp or email, and improve our service. We do not sell your data to third parties.',
        },
        {
          type: 'heading',
          text: 'Your Rights',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'You have the right to access, correct, or delete your personal data at any time. To exercise these rights, contact us at demo@forcemediakw.com.',
        },
      ],
      contentBlocksAr: [
        {
          type: 'heading',
          text: 'سياسة الخصوصية',
          level: 1,
        },
        {
          type: 'paragraph',
          text: 'يلتزم متجر فورس التجريبي بحماية خصوصيتك. توضح هذه السياسة المعلومات التي نجمعها وكيفية استخدامها وحقوقك.',
        },
        {
          type: 'heading',
          text: 'ما نجمعه',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'نجمع: اسمك وتفاصيل الاتصال (لمعالجة الطلبات)، وعنوان التسليم، ومعلومات الدفع (معالجة بأمان من مزود الدفع — لا نخزن أبداً تفاصيل البطاقة)، وسجل الطلبات.',
        },
        {
          type: 'heading',
          text: 'كيف نستخدم بياناتك',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'نستخدم بياناتك لمعالجة طلباتك وتسليمها، وإرسال إشعارات حالة الطلب. لا نبيع بياناتك لأطراف ثالثة.',
        },
        {
          type: 'heading',
          text: 'حقوقك',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'يحق لك الوصول إلى بياناتك الشخصية أو تصحيحها أو حذفها في أي وقت. للممارسة هذه الحقوق، تواصل معنا.',
        },
      ],
    },
    {
      slug: 'terms',
      title: 'Terms & Conditions',
      titleAr: 'الشروط والأحكام',
      isPublished: true,
      position: 5,
      contentBlocks: [
        {
          type: 'heading',
          text: 'Terms & Conditions',
          level: 1,
        },
        {
          type: 'paragraph',
          text: 'By shopping with Force Demo Store, you agree to the following terms. Please read them carefully before placing your order.',
        },
        {
          type: 'heading',
          text: 'Orders',
          level: 2,
        },
        {
          type: 'paragraph',
          text: "All orders are subject to availability. We reserve the right to cancel orders if a product is out of stock. You'll be notified immediately and refunded in full.",
        },
        {
          type: 'heading',
          text: 'Pricing',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'Prices are listed in Kuwaiti Dinar (KWD) and include all applicable taxes. We reserve the right to change prices at any time without notice.',
        },
        {
          type: 'heading',
          text: 'Governing Law',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'These terms are governed by the laws of the State of Kuwait. Any disputes shall be resolved under Kuwait jurisdiction.',
        },
      ],
      contentBlocksAr: [
        {
          type: 'heading',
          text: 'الشروط والأحكام',
          level: 1,
        },
        {
          type: 'paragraph',
          text: 'بالتسوق مع متجر فورس التجريبي، توافق على الشروط التالية. يرجى قراءتها بعناية قبل تقديم طلبك.',
        },
        {
          type: 'heading',
          text: 'الطلبات',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'جميع الطلبات رهينة بالتوفر. نحتفظ بالحق في إلغاء الطلبات إذا نفد المنتج. ستتلقى إشعاراً فورياً واسترداداً كاملاً.',
        },
        {
          type: 'heading',
          text: 'الأسعار',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'الأسعار بالدينار الكويتي (د.ك) وتشمل جميع الضرائب المطبقة. نحتفظ بالحق في تغيير الأسعار في أي وقت.',
        },
        {
          type: 'heading',
          text: 'القانون الحاكم',
          level: 2,
        },
        {
          type: 'paragraph',
          text: 'تخضع هذه الشروط لقوانين دولة الكويت. تُحل أي نزاعات بموجب الاختصاص القضائي الكويتي.',
        },
      ],
    },
  ];

  for (const page of STORE_PAGES) {
    await prisma.storePage.create({
      data: {
        storeId: store.id,
        slug: page.slug,
        title: page.title,
        titleAr: page.titleAr,
        contentBlocks: page.contentBlocks,
        contentBlocksAr: page.contentBlocksAr,
        coverImage: page.coverImage ?? null,
        isPublished: page.isPublished,
        position: page.position,
      },
    });
  }
  console.log(
    `  ✓ ${STORE_PAGES.length} store pages (about, contact, shipping, returns, privacy, terms)`
  );

  // ── 10. FAQ entries ────────────────────────────────────────────────────────
  console.log('\n[10/13] Seeding FAQ entries…');
  await prisma.storeFaq.deleteMany({ where: { storeId: store.id } });

  const FAQS = [
    {
      question: 'How long does delivery take?',
      questionAr: 'كم يستغرق التوصيل؟',
      answer:
        'Standard delivery within Kuwait takes 1–2 business days. Same-day delivery is available for orders placed before 12 pm in selected areas.',
      answerAr:
        'يستغرق التوصيل العادي داخل الكويت 1-2 أيام عمل. التوصيل في نفس اليوم متاح للطلبات المقدّمة قبل الساعة 12 ظهراً في مناطق مختارة.',
      orderIndex: 0,
    },
    {
      question: 'What is your return policy?',
      questionAr: 'ما هي سياسة الإرجاع؟',
      answer:
        'We accept returns within 14 days of delivery for unused items in their original packaging. Contact us on WhatsApp with your order number to start a return.',
      answerAr:
        'نقبل الإرجاع خلال 14 يوماً من التسليم للعناصر غير المستخدمة في عبواتها الأصلية. تواصل معنا على واتساب برقم طلبك لبدء الإرجاع.',
      orderIndex: 1,
    },
    {
      question: 'Do you offer cash on delivery?',
      questionAr: 'هل تقدمون الدفع عند الاستلام؟',
      answer:
        'Yes! Cash on delivery (COD) is available for all orders within Kuwait. Simply select "Cash on Delivery" at checkout.',
      answerAr:
        'نعم! الدفع عند الاستلام متاح لجميع الطلبات داخل الكويت. فقط اختر "الدفع عند الاستلام" عند الدفع.',
      orderIndex: 2,
    },
    {
      question: 'How do I track my order?',
      questionAr: 'كيف أتتبع طلبي؟',
      answer:
        'You\'ll receive a WhatsApp message with a tracking link when your order ships. You can also log in to your account and view real-time order status from the "My Orders" page.',
      answerAr:
        'ستتلقى رسالة واتساب مع رابط التتبع عند شحن طلبك. يمكنك أيضاً تسجيل الدخول وعرض حالة الطلب في الوقت الفعلي من صفحة "طلباتي".',
      orderIndex: 3,
    },
    {
      question: 'Can I change or cancel my order?',
      questionAr: 'هل يمكنني تغيير طلبي أو إلغاؤه؟',
      answer:
        'You can change or cancel your order within 1 hour of placing it. After that, the order may already be in processing. Message us on WhatsApp as soon as possible if you need to make changes.',
      answerAr:
        'يمكنك تغيير طلبك أو إلغاؤه خلال ساعة واحدة من تقديمه. بعد ذلك، قد يكون الطلب في مرحلة المعالجة. راسلنا على واتساب في أقرب وقت ممكن.',
      orderIndex: 4,
    },
    {
      question: 'Are products covered by a warranty?',
      questionAr: 'هل المنتجات مشمولة بضمان؟',
      answer:
        "Electronics come with the manufacturer's warranty (usually 1 year). For other products, please check the individual product page or contact our support team for details.",
      answerAr:
        'الإلكترونيات تأتي مع ضمان الشركة المصنّعة (عادة سنة واحدة). للمنتجات الأخرى، يرجى التحقق من صفحة المنتج الفردية أو التواصل مع فريق الدعم.',
      orderIndex: 5,
    },
    {
      question: 'Do you offer gift wrapping?',
      questionAr: 'هل تقدمون تغليف الهدايا؟',
      answer:
        'Yes! Add a note in the "Order Notes" field at checkout requesting gift wrapping. For our premium gift hampers, decorative packaging is included by default.',
      answerAr:
        'نعم! أضف ملاحظة في حقل "ملاحظات الطلب" عند الدفع لطلب تغليف الهدايا. لسلال الهدايا الفاخرة، التغليف الزخرفي مضمّن افتراضياً.',
      orderIndex: 6,
    },
    {
      question: 'How do I earn loyalty points?',
      questionAr: 'كيف أكسب نقاط الولاء؟',
      answer:
        'You earn 10 points for every 1 KWD spent. Points can be redeemed for discounts on future orders. You also earn bonus points for writing reviews and on your birthday!',
      answerAr:
        'تكسب 10 نقاط لكل 1 د.ك تنفقه. يمكن استرداد النقاط للحصول على خصومات على الطلبات المستقبلية. كما تكسب نقاطاً إضافية مقابل كتابة التقييمات وفي عيد ميلادك!',
      orderIndex: 7,
    },
  ];

  await prisma.storeFaq.createMany({
    data: FAQS.map(faq => ({
      storeId: store.id,
      ...faq,
      isActive: true,
      manuallyEdited: true,
      aiDrafted: false,
    })),
  });
  console.log(`  ✓ ${FAQS.length} FAQ entries`);

  // ── 11. Store locations / branches ────────────────────────────────────────
  console.log('\n[11/13] Seeding store locations…');
  await prisma.storeLocation.deleteMany({ where: { storeId: store.id } });

  await prisma.storeLocation.createMany({
    data: [
      {
        storeId: store.id,
        name: 'Kuwait City — Main Branch',
        nameAr: 'مدينة الكويت — الفرع الرئيسي',
        country: 'Kuwait',
        countryAr: 'الكويت',
        address: 'Block 5, Fahad Al-Salem Street, Kuwait City',
        addressAr: 'قطعة 5، شارع فهد السالم، مدينة الكويت',
        phone: '+96522209079',
        whatsapp: '+96599990000',
        mapsUrl: 'https://maps.google.com/?q=Kuwait+City+Kuwait',
        hours: 'Sat–Thu: 9 am – 10 pm\nFri: 4 pm – 10 pm',
        hoursAr: 'السبت–الخميس: ٩ ص – ١٠ م\nالجمعة: ٤ م – ١٠ م',
        isPublished: true,
        position: 0,
      },
      {
        storeId: store.id,
        name: 'Salmiya — East Branch',
        nameAr: 'السالمية — الفرع الشرقي',
        country: 'Kuwait',
        countryAr: 'الكويت',
        address: 'Arabian Gulf Street, Salmiya, Hawalli Governorate',
        addressAr: 'شارع الخليج العربي، السالمية، محافظة حولي',
        phone: '+96522209080',
        whatsapp: '+96599990001',
        mapsUrl: 'https://maps.google.com/?q=Salmiya+Kuwait',
        hours: 'Sat–Thu: 10 am – 10 pm\nFri: 4 pm – 10 pm',
        hoursAr: 'السبت–الخميس: ١٠ ص – ١٠ م\nالجمعة: ٤ م – ١٠ م',
        isPublished: true,
        position: 1,
      },
    ],
  });
  // Enable locations on the store now that we have data
  await prisma.store.update({
    where: { id: store.id },
    data: { locationsEnabled: true },
  });
  console.log('  ✓ 2 store locations (Kuwait City + Salmiya)');

  // ── 12. Promo banners + extra carousels in layoutSettings ─────────────────
  console.log('\n[12/13] Enriching layoutSettings with promo sections + page settings…');

  // Product IDs for the manual carousel — use the first 4 products from createdProducts
  const manualCarouselIds = createdProducts.slice(0, 4).map(p => p.id);

  const enrichedLayout = {
    hero: {
      slides: HERO_SLIDES,
    },
    categories: {
      enabled: true,
      layout: 'grid' as const,
      captionPosition: 'below' as const,
      desktopColumns: 3 as const,
      mobileColumns: 2 as const,
      cardSize: 'sm' as const,
      cardGap: 'normal' as const,
      title: 'Shop by Category',
      titleAr: 'تسوق حسب الفئة',
      subtitle: 'Explore our curated collections',
      subtitleAr: 'استكشف مجموعاتنا المختارة',
      kicker: 'Collections',
      kickerAr: 'المجموعات',
      bgColor: 'token:card',
    },
    newArrivals: {
      enabled: true,
      limit: 8,
      title: 'Just Arrived',
      titleAr: 'وصل حديثاً',
      subtitle: 'Fresh picks added this week',
      subtitleAr: 'اختيارات جديدة أضفناها هذا الأسبوع',
      kicker: 'New',
      kickerAr: 'جديد',
      cardSize: 'sm' as const,
      cardGap: 'normal' as const,
    },
    bestSellers: {
      enabled: true,
      limit: 8,
      title: 'Best Sellers',
      titleAr: 'الأكثر مبيعاً',
      subtitle: 'What everyone is buying right now',
      subtitleAr: 'ما يشتريه الجميع الآن',
      kicker: 'Trending',
      kickerAr: 'رائج',
      cardSize: 'sm' as const,
      cardGap: 'normal' as const,
      bgColor: 'token:card',
    },
    testimonials: {
      enabled: true,
      minRating: 4,
      verifiedOnly: true,
      title: 'What Our Customers Say',
      titleAr: 'ماذا يقول عملاؤنا',
      subtitle: 'Real reviews from real shoppers',
      subtitleAr: 'تقييمات حقيقية من متسوقين حقيقيين',
    },
    reviewSection: {
      enabled: true,
    },
    brandStory: {
      enabled: true,
      bgColor: 'token:primary',
    },
    trustStrip: {
      enabled: true,
      layout: 'horizontal' as const,
      size: 'md' as const,
      bgColor: 'token:card',
    },
    blogCarousel: {
      enabled: true,
      limit: 6,
      title: 'From Our Blog',
      titleAr: 'من مدونتنا',
      subtitle: 'Tips, guides, and stories',
      subtitleAr: 'نصائح وأدلة وقصص',
      kicker: 'Blog',
      kickerAr: 'المدونة',
    },
    announcement: {
      enabled: true,
      bgColor: 'token:primary',
    },
    header: {
      enabled: true,
      sticky: true,
    },
    footer: {
      enabled: true,
      bgColor: 'token:primary',
    },
    // Two extra promotional carousels demonstrating the feature
    extraCarousels: [
      {
        id: 'extra-featured-picks',
        productSource: 'featured' as const,
        enabled: true,
        limit: 6,
        title: "Editor's Picks",
        titleAr: 'اختيارات المحرر',
        subtitle: 'Handpicked favourites from our team',
        subtitleAr: 'مفضلات مختارة بعناية من فريقنا',
        kicker: 'Curated',
        kickerAr: 'مختار',
        cardSize: 'md' as const,
        cardGap: 'normal' as const,
        bgColor: 'token:card',
        showCardFrame: true,
        cardFrameStyle: 'soft' as const,
      },
      {
        id: 'extra-manual-spotlight',
        productSource: 'manual' as const,
        manualProductIds: manualCarouselIds,
        enabled: true,
        limit: 4,
        title: 'Staff Spotlight',
        titleAr: 'اختيارات الفريق',
        subtitle: 'Products our team uses and loves every day',
        subtitleAr: 'منتجات يستخدمها فريقنا ويحبها كل يوم',
        kicker: 'Staff Picks',
        kickerAr: 'اختيارات الموظفين',
        cardSize: 'sm' as const,
        cardGap: 'normal' as const,
      },
    ],
    // Per-page page-builder settings so every page editor shows content
    productsPage: {
      bgColor: 'token:card',
      colorScheme: 'auto' as const,
      density: 'normal' as const,
      textScale: 'normal' as const,
    },
    productDetailPage: {
      bgColor: 'token:card',
      colorScheme: 'auto' as const,
      density: 'normal' as const,
      textScale: 'normal' as const,
      imageAspect: 'square' as const,
    },
    categoriesPage: {
      bgColor: 'token:card',
      colorScheme: 'auto' as const,
      density: 'normal' as const,
    },
    locationsPage: {
      bgColor: 'token:card',
      colorScheme: 'auto' as const,
      density: 'normal' as const,
    },
    checkoutPage: {
      bgColor: 'token:card',
      colorScheme: 'auto' as const,
      density: 'normal' as const,
    },
    cartPage: {
      bgColor: 'token:card',
      colorScheme: 'auto' as const,
      density: 'normal' as const,
    },
    filterSidebar: {
      enabled: true,
      defaultOpen: true,
      bgColor: 'token:primary',
    },
    sizing: {
      heroAspect: '2.45:1' as const,
      productImageAspect: '1:1' as const,
      categoryImageAspect: '1:1' as const,
    },
    sectionOrder: [
      'hero',
      'categories',
      'newArrivals',
      'bestSellers',
      'brandStory',
      'blogCarousel',
      'trustStrip',
      'testimonials',
    ] as const,
  };

  await prisma.store.update({
    where: { id: store.id },
    data: { layoutSettings: enrichedLayout },
  });
  console.log('  ✓ layoutSettings enriched (2 extra carousels + 6 per-page settings)');

  // ── 13. HowTo entry (demonstrates StoreHowto model) ───────────────────────
  console.log('\n[13/13] Seeding HowTo entry…');
  await prisma.storeHowto.deleteMany({ where: { storeId: store.id } });

  await prisma.storeHowto.create({
    data: {
      storeId: store.id,
      title: 'How to Place an Order',
      titleAr: 'كيفية تقديم الطلب',
      description: 'Follow these simple steps to place your first order with Force Demo Store.',
      descriptionAr: 'اتبع هذه الخطوات البسيطة لتقديم طلبك الأول مع متجر فورس التجريبي.',
      steps: [
        {
          name: 'Browse Products',
          text: "Explore our categories or use the search bar to find what you're looking for.",
        },
        {
          name: 'Add to Cart',
          text: 'Click "Add to Cart" on any product you want to purchase. You can add multiple items.',
        },
        {
          name: 'Review Your Cart',
          text: 'Open your cart, review the items and quantities, and apply any discount codes.',
        },
        {
          name: 'Enter Delivery Details',
          text: 'Fill in your name, phone number, and delivery address at checkout.',
        },
        {
          name: 'Choose Payment',
          text: 'Select your preferred payment method: KNET, Visa/Mastercard, or Cash on Delivery.',
        },
        {
          name: 'Confirm Order',
          text: 'Review your order summary and click "Place Order". You\'ll receive a WhatsApp confirmation immediately.',
        },
      ],
      stepsAr: [
        {
          name: 'تصفح المنتجات',
          text: 'استكشف فئاتنا أو استخدم شريط البحث للعثور على ما تبحث عنه.',
        },
        {
          name: 'أضف إلى السلة',
          text: 'انقر على "أضف إلى السلة" لأي منتج تريد شراءه. يمكنك إضافة عناصر متعددة.',
        },
        { name: 'راجع سلتك', text: 'افتح سلتك وراجع العناصر والكميات وطبّق أي رموز خصم.' },
        { name: 'أدخل تفاصيل التوصيل', text: 'أدخل اسمك ورقم هاتفك وعنوان التوصيل عند الدفع.' },
        {
          name: 'اختر طريقة الدفع',
          text: 'اختر طريقة الدفع المفضلة: كي-نت أو فيزا/ماستركارد أو الدفع عند الاستلام.',
        },
        {
          name: 'أكد الطلب',
          text: 'راجع ملخص طلبك وانقر على "تقديم الطلب". ستتلقى تأكيداً عبر واتساب فوراً.',
        },
      ],
      orderIndex: 0,
      isActive: true,
      manuallyEdited: true,
      aiDrafted: false,
    },
  });
  console.log('  ✓ 1 HowTo entry ("How to Place an Order")');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Demo store seeded successfully!                 ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n  Slug:     ${store.slug}`);
  console.log(`  Store ID: ${store.id}`);
  console.log(`  Plan:     ${store.plan}`);
  console.log(`  Template: ${store.template}`);
  console.log(`\n  Access:   /<platform-domain>/${store.slug}`);
  console.log(`  Admin:    /stores/${store.id}/dashboard\n`);
}

main()
  .catch(e => {
    console.error('\n[seed-demo-store] FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
