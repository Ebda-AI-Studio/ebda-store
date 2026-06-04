/**
 * Load-test Store Seeder
 *
 * Creates N disposable test stores for multi-store concurrent load testing.
 * Each store gets a handful of categories and ~12 products so the public
 * read path (product list / detail / categories) returns real data across
 * distinct tenants.
 *
 * Usage:
 *   tsx prisma/seed-loadtest-stores.ts            # seed (N=20 default)
 *   LOADTEST_STORE_COUNT=5 tsx prisma/seed-loadtest-stores.ts
 *   tsx prisma/seed-loadtest-stores.ts --cleanup  # delete all loadtest stores + user
 *
 * On success the store IDs are written to loadtests/.loadtest-store-ids.txt
 * (comma-separated, single line) for consumption by multi-store-storm.js.
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// ============================================
// Config
// ============================================

const LOADTEST_USER_EMAIL = 'loadtest+stores@forcemediakw.com';
const LOADTEST_STORE_SLUG_PREFIX = 'loadtest-store-';
const STORE_COUNT = parseInt(process.env.LOADTEST_STORE_COUNT ?? '20', 10);
const IS_CLEANUP = process.argv.includes('--cleanup');

// Path to write store IDs for k6 consumption (relative to repo root).
// __dirname = packages/database/prisma → go up 3 levels to reach repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STORE_IDS_FILE = path.join(REPO_ROOT, 'loadtests', '.loadtest-store-ids.txt');

// ============================================
// Helper Functions (mirrored from seed.ts)
// ============================================

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function priceInFils(kwd: number): number {
  return Math.round(kwd * 1000);
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

/** Zero-pad a number to 3 digits, e.g. 3 → "003" */
function zeroPad(n: number, width = 3): string {
  return String(n).padStart(width, '0');
}

// ============================================
// Demo Data — reused from seed.ts patterns
// ============================================

const LOADTEST_CATEGORIES = [
  {
    name: 'Electronics',
    nameAr: 'إلكترونيات',
    description: 'Phones, laptops, and gadgets',
    descriptionAr: 'هواتف، لابتوبات، وأجهزة إلكترونية',
    children: [
      { name: 'Smartphones', nameAr: 'هواتف ذكية' },
      { name: 'Accessories', nameAr: 'إكسسوارات' },
    ],
  },
  {
    name: 'Fashion',
    nameAr: 'أزياء',
    description: 'Clothing and accessories',
    descriptionAr: 'ملابس وإكسسوارات',
    children: [
      { name: 'Men', nameAr: 'رجال' },
      { name: 'Women', nameAr: 'نساء' },
    ],
  },
  {
    name: 'Home',
    nameAr: 'المنزل',
    description: 'Furniture and decor',
    descriptionAr: 'أثاث وديكور',
    children: [
      { name: 'Furniture', nameAr: 'أثاث' },
      { name: 'Decor', nameAr: 'ديكور' },
    ],
  },
];

/** Build 12 products for a store, varying names so caches differ per tenant. */
function buildLoadtestProducts(storeIndex: number) {
  const tag = `ST${zeroPad(storeIndex)}`;
  return [
    {
      name: `${tag} iPhone 15 Pro Max`,
      nameAr: `آيفون 15 برو ماكس ${tag}`,
      description: 'The most advanced iPhone ever with titanium design and A17 Pro chip.',
      descriptionAr: 'أحدث آيفون بتصميم تيتانيوم وشريحة A17 برو.',
      price: 450,
      compareAtPrice: 500,
      inventory: 25,
      category: 'Smartphones',
      featured: true,
      isNew: true,
      images: ['https://images.unsplash.com/photo-1696348149297-5ffcc9d6a41a?w=800'],
    },
    {
      name: `${tag} Samsung Galaxy S24 Ultra`,
      nameAr: `سامسونج جالاكسي S24 الترا ${tag}`,
      description: 'Premium Android smartphone with S Pen and AI features.',
      descriptionAr: 'هاتف أندرويد فاخر مع قلم S وميزات الذكاء الاصطناعي.',
      price: 380,
      compareAtPrice: 420,
      inventory: 30,
      category: 'Smartphones',
      featured: true,
      images: ['https://images.unsplash.com/photo-1610945415295-d9bbf067e59c?w=800'],
    },
    {
      name: `${tag} AirPods Pro 2`,
      nameAr: `إيربودز برو 2 ${tag}`,
      description: 'Premium wireless earbuds with active noise cancellation.',
      descriptionAr: 'سماعات لاسلكية فاخرة مع إلغاء الضوضاء.',
      price: 85,
      inventory: 50,
      category: 'Accessories',
      isNew: true,
      images: ['https://images.unsplash.com/photo-1588423771073-b8903fbb85b5?w=800'],
    },
    {
      name: `${tag} Wireless Charger`,
      nameAr: `شاحن لاسلكي ${tag}`,
      description: 'Fast wireless charger compatible with all Qi devices.',
      descriptionAr: 'شاحن لاسلكي سريع لجميع الأجهزة.',
      price: 25,
      inventory: 100,
      category: 'Accessories',
      images: ['https://images.unsplash.com/photo-1591348278863-a8fb3887e2aa?w=800'],
    },
    {
      name: `${tag} Premium Cotton T-Shirt`,
      nameAr: `تيشيرت قطن فاخر ${tag}`,
      description: 'Comfortable cotton t-shirt for everyday wear.',
      descriptionAr: 'تيشيرت قطني مريح للارتداء اليومي.',
      price: 15,
      compareAtPrice: 20,
      inventory: 100,
      category: 'Men',
      images: ['https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800'],
    },
    {
      name: `${tag} Classic Denim Jeans`,
      nameAr: `جينز دينم كلاسيكي ${tag}`,
      description: 'Timeless denim jeans with perfect fit.',
      descriptionAr: 'جينز دينم كلاسيكي بمقاس مثالي.',
      price: 45,
      inventory: 75,
      category: 'Men',
      images: ['https://images.unsplash.com/photo-1542272604-787c3835535d?w=800'],
    },
    {
      name: `${tag} Elegant Abaya`,
      nameAr: `عباية أنيقة ${tag}`,
      description: 'Beautifully designed abaya with modern touches.',
      descriptionAr: 'عباية بتصميم جميل ولمسات عصرية.',
      price: 75,
      inventory: 40,
      category: 'Women',
      featured: true,
      images: ['https://images.unsplash.com/photo-1590243735654-f1c7a9f00b2e?w=800'],
    },
    {
      name: `${tag} Designer Handbag`,
      nameAr: `حقيبة يد مصممة ${tag}`,
      description: 'Luxury handbag for every occasion.',
      descriptionAr: 'حقيبة يد فاخرة لكل مناسبة.',
      price: 120,
      compareAtPrice: 150,
      inventory: 20,
      category: 'Women',
      isNew: true,
      images: ['https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=800'],
    },
    {
      name: `${tag} Modern Sofa Set`,
      nameAr: `طقم كنب عصري ${tag}`,
      description: 'Comfortable 3-piece sofa set for your living room.',
      descriptionAr: 'طقم كنب مريح من 3 قطع لغرفة المعيشة.',
      price: 850,
      inventory: 5,
      category: 'Furniture',
      featured: true,
      images: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800'],
    },
    {
      name: `${tag} Dining Table`,
      nameAr: `طاولة طعام ${tag}`,
      description: 'Elegant dining table for 6 persons.',
      descriptionAr: 'طاولة طعام أنيقة لـ 6 أشخاص.',
      price: 350,
      inventory: 8,
      category: 'Furniture',
      images: ['https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800'],
    },
    {
      name: `${tag} Decorative Lamp`,
      nameAr: `مصباح ديكوري ${tag}`,
      description: 'Modern decorative lamp for ambient lighting.',
      descriptionAr: 'مصباح ديكوري عصري للإضاءة المحيطة.',
      price: 45,
      inventory: 30,
      category: 'Decor',
      images: ['https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800'],
    },
    {
      name: `${tag} Wall Art Print`,
      nameAr: `لوحة فنية للجدار ${tag}`,
      description: 'Beautiful minimalist wall art for modern interiors.',
      descriptionAr: 'لوحة فنية بسيطة وجميلة للمنازل العصرية.',
      price: 30,
      inventory: 60,
      category: 'Decor',
      isNew: true,
      images: ['https://images.unsplash.com/photo-1561214115-f2f134cc4912?w=800'],
    },
  ];
}

// ============================================
// Seed: Loadtest User
// ============================================

async function seedLoadtestUser() {
  console.log(`Ensuring load-test user exists: ${LOADTEST_USER_EMAIL}`);

  const existing = await prisma.user.findFirst({
    where: { email: LOADTEST_USER_EMAIL, storeId: null },
  });

  if (existing) {
    console.log('  Load-test user already exists, reusing.');
    return existing;
  }

  const user = await prisma.user.create({
    data: {
      email: LOADTEST_USER_EMAIL,
      passwordHash: await hashPassword(`LT-${Date.now()}-not-for-login`),
      firstName: 'LoadTest',
      lastName: 'Stores',
      role: 'store_admin',
      emailVerified: true,
      language: 'en',
    },
  });

  console.log(`  Created load-test user: ${user.id}`);
  return user;
}

// ============================================
// Seed: One store (idempotent)
// ============================================

async function seedLoadtestStore(ownerId: string, storeIndex: number) {
  const slug = `${LOADTEST_STORE_SLUG_PREFIX}${zeroPad(storeIndex)}`;

  const existing = await prisma.store.findFirst({ where: { slug } });

  if (existing) {
    console.log(`  [${slug}] already exists, reusing (id=${existing.id})`);
    return existing;
  }

  const store = await prisma.store.create({
    data: {
      name: `LoadTest Store ${zeroPad(storeIndex)}`,
      nameAr: `متجر اختبار الحمل ${zeroPad(storeIndex)}`,
      slug,
      ownerId,
      status: 'active',
      plan: 'starter',
      description: `Disposable load-test store #${storeIndex}. Safe to delete.`,
      descriptionAr: `متجر اختبار حمل مؤقت رقم ${storeIndex}`,
      currency: 'KWD',
      template: 'modern',
      theme: {
        primaryColor: '26 100% 50%',
        primaryForeground: '0 0% 100%',
        secondaryColor: '220 14% 96%',
        secondaryForeground: '220 9% 46%',
        fontFamily: 'modern',
        borderRadius: 'lg',
      },
      socialLinks: {},
      marketingPixels: {},
    },
  });

  console.log(`  [${slug}] created (id=${store.id})`);
  return store;
}

// ============================================
// Seed: Categories for one store (idempotent)
// ============================================

async function seedLoadtestCategories(storeId: string) {
  const existingCount = await prisma.category.count({ where: { storeId } });
  if (existingCount > 0) {
    // Already seeded; return existing leaf categories for the product mapper.
    return prisma.category.findMany({ where: { storeId } });
  }

  for (const catData of LOADTEST_CATEGORIES) {
    const parent = await prisma.category.create({
      data: {
        storeId,
        name: catData.name,
        nameAr: catData.nameAr,
        slug: generateSlug(catData.name),
        description: catData.description,
        descriptionAr: catData.descriptionAr,
        isActive: true,
      },
    });

    for (const child of catData.children ?? []) {
      await prisma.category.create({
        data: {
          storeId,
          name: child.name,
          nameAr: child.nameAr,
          slug: generateSlug(child.name),
          parentId: parent.id,
          isActive: true,
        },
      });
    }
  }

  return prisma.category.findMany({ where: { storeId } });
}

// ============================================
// Seed: Products for one store (idempotent)
// ============================================

async function seedLoadtestProducts(storeId: string, storeIndex: number) {
  const existingCount = await prisma.product.count({ where: { storeId } });
  if (existingCount > 0) {
    return; // Already seeded — idempotent
  }

  const categories = await prisma.category.findMany({ where: { storeId } });
  const categoryMap = new Map(categories.map(c => [c.name, c.id]));

  const products = buildLoadtestProducts(storeIndex);

  for (let i = 0; i < products.length; i++) {
    const productData = products[i];
    const categoryId = categoryMap.get(productData.category);

    const product = await prisma.product.create({
      data: {
        storeId,
        name: productData.name,
        nameAr: productData.nameAr,
        slug: generateSlug(productData.name),
        description: productData.description,
        descriptionAr: productData.descriptionAr,
        price: priceInFils(productData.price),
        compareAtPrice: productData.compareAtPrice ? priceInFils(productData.compareAtPrice) : null,
        inventory: productData.inventory,
        status: 'active',
        featured: productData.featured ?? false,
        isNew: productData.isNew ?? false,
        // SKU must be unique within a store ([storeId, sku] @@unique in schema).
        // Include storeIndex + product index to guarantee no cross-store collision.
        sku: `LT-S${zeroPad(storeIndex)}-P${zeroPad(i + 1, 2)}`,
      },
    });

    // Add a representative image
    if (productData.images.length > 0) {
      await prisma.productImage.create({
        data: {
          productId: product.id,
          url: productData.images[0],
          alt: productData.name,
          position: 0,
        },
      });
    }

    // Link to category
    if (categoryId) {
      await prisma.productCategory.create({
        data: { productId: product.id, categoryId },
      });
    }
  }
}

// ============================================
// Cleanup
// ============================================

async function cleanup() {
  console.log('Cleaning up load-test stores and user...');

  // Find all loadtest stores.
  const stores = await prisma.store.findMany({
    where: { slug: { startsWith: LOADTEST_STORE_SLUG_PREFIX } },
    select: { id: true, slug: true },
  });

  if (stores.length === 0) {
    console.log('  No load-test stores found — nothing to clean up.');
  } else {
    for (const store of stores) {
      // Orders MUST go first: Order→store is onDelete:Restrict (blocks store
      // delete) and OrderItem→product is Restrict (blocks product delete).
      // Deleting the Order cascades its OrderItems + Payments. The checkout
      // storm scenario creates real COD orders on these stores, so without
      // this the cleanup FK-fails. Read-only runs simply find zero orders.
      await prisma.order.deleteMany({ where: { storeId: store.id } });
      // Explicit cascade: products (with images + category links), categories, then store.
      // The FK relations already use onDelete: Cascade for most child tables,
      // but we delete explicitly to be safe and visible.
      await prisma.productCategory.deleteMany({ where: { product: { storeId: store.id } } });
      await prisma.productImage.deleteMany({ where: { product: { storeId: store.id } } });
      await prisma.product.deleteMany({ where: { storeId: store.id } });
      await prisma.category.deleteMany({ where: { storeId: store.id } });
      await prisma.store.delete({ where: { id: store.id } });
      console.log(`  Deleted store: ${store.slug} (${store.id})`);
    }
  }

  // Delete the load-test user (storeId=null to target the admin-namespace row).
  const ltUser = await prisma.user.findFirst({
    where: { email: LOADTEST_USER_EMAIL, storeId: null },
  });
  if (ltUser) {
    await prisma.user.delete({ where: { id: ltUser.id } });
    console.log(`  Deleted load-test user: ${ltUser.id}`);
  } else {
    console.log('  Load-test user not found — nothing to delete.');
  }

  // Remove the IDs file if it exists.
  if (fs.existsSync(STORE_IDS_FILE)) {
    fs.unlinkSync(STORE_IDS_FILE);
    console.log(`  Removed ${STORE_IDS_FILE}`);
  }

  console.log('Cleanup complete.');
}

// ============================================
// Main
// ============================================

async function main() {
  if (IS_CLEANUP) {
    await cleanup();
    return;
  }

  console.log(`Seeding ${STORE_COUNT} load-test stores...\n`);

  const owner = await seedLoadtestUser();
  const storeIds: string[] = [];

  for (let i = 1; i <= STORE_COUNT; i++) {
    const store = await seedLoadtestStore(owner.id, i);
    await seedLoadtestCategories(store.id);
    await seedLoadtestProducts(store.id, i);
    storeIds.push(store.id);
    process.stdout.write(`  [${i}/${STORE_COUNT}] ${store.slug} ready\n`);
  }

  // Write the IDs file for k6.
  const idsLine = storeIds.join(',');
  fs.mkdirSync(path.dirname(STORE_IDS_FILE), { recursive: true });
  fs.writeFileSync(STORE_IDS_FILE, idsLine + '\n', 'utf8');

  console.log(`\nDone. ${STORE_COUNT} stores ready.`);
  console.log(`Store IDs written to: ${STORE_IDS_FILE}`);
  console.log(`\nTo run the multi-store storm scenario:`);
  console.log(
    `  STORE_IDS=$(cat loadtests/.loadtest-store-ids.txt) ./loadtests/run.sh multi-store-storm`
  );
}

main()
  .catch(e => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
