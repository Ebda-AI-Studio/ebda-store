/**
 * Database Seed Script
 *
 * Creates demo data for development and testing:
 * - Super Admin user
 * - Demo store with products and categories
 * - Sample customers and orders
 *
 * Run with: npx ts-node --esm src/seed.ts
 */

import { createPrismaClient } from '../src/client';
import * as bcrypt from 'bcryptjs';

import { roundToMinor, REGION } from '@ebda/shared';
const prisma = createPrismaClient({
  connectionString: process.env.DATABASE_URL ?? '',
  role: 'owner',
});

// ============================================
// Helper Functions
// ============================================

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Demo prices below were authored in a 3-decimal currency; Ebda seeds EGP, so scale them up
// (rough 1 unit ≈ 100 EGP — demo data only, not a conversion rate).
const DEMO_PRICE_FACTOR = 100;

/** Demo major-unit price (legacy numbers) → integer EGP piastres. */
function priceInFils(major: number): number {
  return roundToMinor(major * DEMO_PRICE_FACTOR);
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

// ============================================
// Demo Data
// ============================================

const DEMO_CATEGORIES = [
  {
    name: 'Electronics',
    nameAr: 'إلكترونيات',
    description: 'Phones, laptops, and gadgets',
    descriptionAr: 'هواتف، لابتوبات، وأجهزة إلكترونية',
    children: [
      { name: 'Smartphones', nameAr: 'هواتف ذكية' },
      { name: 'Laptops', nameAr: 'لابتوبات' },
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
      { name: 'Kids', nameAr: 'أطفال' },
    ],
  },
  {
    name: 'Home & Garden',
    nameAr: 'المنزل والحديقة',
    description: 'Furniture and decor',
    descriptionAr: 'أثاث وديكور',
    children: [
      { name: 'Furniture', nameAr: 'أثاث' },
      { name: 'Decor', nameAr: 'ديكور' },
      { name: 'Kitchen', nameAr: 'مطبخ' },
    ],
  },
];

const DEMO_PRODUCTS = [
  // Electronics - Smartphones
  {
    name: 'iPhone 15 Pro Max',
    nameAr: 'آيفون 15 برو ماكس',
    description: 'The most advanced iPhone ever with titanium design and A17 Pro chip.',
    descriptionAr: 'أحدث آيفون بتصميم تيتانيوم وشريحة A17 برو.',
    price: 450,
    compareAtPrice: 500,
    inventory: 25,
    category: 'Smartphones',
    featured: true,
    isNew: true,
    images: [
      'https://images.unsplash.com/photo-1696348149297-5ffcc9d6a41a?w=800',
      'https://images.unsplash.com/photo-1695048133096-e2e9adaebb4b?w=800',
    ],
  },
  {
    name: 'Samsung Galaxy S24 Ultra',
    nameAr: 'سامسونج جالاكسي S24 الترا',
    description: 'Premium Android smartphone with S Pen and AI features.',
    descriptionAr: 'هاتف أندرويد فاخر مع قلم S وميزات الذكاء الاصطناعي.',
    price: 380,
    compareAtPrice: 420,
    inventory: 30,
    category: 'Smartphones',
    featured: true,
    images: ['https://images.unsplash.com/photo-1610945415295-d9bbf067e59c?w=800'],
  },
  // Electronics - Laptops
  {
    name: 'MacBook Pro 16"',
    nameAr: 'ماك بوك برو 16 إنش',
    description: 'Powerful laptop for professionals with M3 Max chip.',
    descriptionAr: 'لابتوب قوي للمحترفين بشريحة M3 ماكس.',
    price: 950,
    inventory: 10,
    category: 'Laptops',
    featured: true,
    images: ['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800'],
  },
  {
    name: 'Dell XPS 15',
    nameAr: 'ديل XPS 15',
    description: 'Premium Windows laptop with stunning display.',
    descriptionAr: 'لابتوب ويندوز فاخر بشاشة مذهلة.',
    price: 650,
    compareAtPrice: 750,
    inventory: 15,
    category: 'Laptops',
    images: ['https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800'],
  },
  // Electronics - Accessories
  {
    name: 'AirPods Pro 2',
    nameAr: 'إيربودز برو 2',
    description: 'Premium wireless earbuds with active noise cancellation.',
    descriptionAr: 'سماعات لاسلكية فاخرة مع إلغاء الضوضاء.',
    price: 85,
    inventory: 50,
    category: 'Accessories',
    isNew: true,
    images: ['https://images.unsplash.com/photo-1588423771073-b8903fbb85b5?w=800'],
  },
  // Fashion - Men
  {
    name: 'Premium Cotton T-Shirt',
    nameAr: 'تيشيرت قطن فاخر',
    description: 'Comfortable cotton t-shirt for everyday wear.',
    descriptionAr: 'تيشيرت قطني مريح للارتداء اليومي.',
    price: 15,
    compareAtPrice: 20,
    inventory: 100,
    category: 'Men',
    images: ['https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800'],
  },
  {
    name: 'Classic Denim Jeans',
    nameAr: 'جينز دينم كلاسيكي',
    description: 'Timeless denim jeans with perfect fit.',
    descriptionAr: 'جينز دينم كلاسيكي بمقاس مثالي.',
    price: 45,
    inventory: 75,
    category: 'Men',
    images: ['https://images.unsplash.com/photo-1542272604-787c3835535d?w=800'],
  },
  // Fashion - Women
  {
    name: 'Elegant Abaya',
    nameAr: 'عباية أنيقة',
    description: 'Beautifully designed abaya with modern touches.',
    descriptionAr: 'عباية بتصميم جميل ولمسات عصرية.',
    price: 75,
    inventory: 40,
    category: 'Women',
    featured: true,
    images: ['https://images.unsplash.com/photo-1590243735654-f1c7a9f00b2e?w=800'],
  },
  {
    name: 'Designer Handbag',
    nameAr: 'حقيبة يد مصممة',
    description: 'Luxury handbag for every occasion.',
    descriptionAr: 'حقيبة يد فاخرة لكل مناسبة.',
    price: 120,
    compareAtPrice: 150,
    inventory: 20,
    category: 'Women',
    isNew: true,
    images: ['https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=800'],
  },
  // Home & Garden - Furniture
  {
    name: 'Modern Sofa Set',
    nameAr: 'طقم كنب عصري',
    description: 'Comfortable 3-piece sofa set for your living room.',
    descriptionAr: 'طقم كنب مريح من 3 قطع لغرفة المعيشة.',
    price: 850,
    inventory: 5,
    category: 'Furniture',
    featured: true,
    images: ['https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800'],
  },
  {
    name: 'Dining Table',
    nameAr: 'طاولة طعام',
    description: 'Elegant dining table for 6 persons.',
    descriptionAr: 'طاولة طعام أنيقة لـ 6 أشخاص.',
    price: 350,
    inventory: 8,
    category: 'Furniture',
    images: ['https://images.unsplash.com/photo-1617806118233-18e1de247200?w=800'],
  },
  // Home & Garden - Decor
  {
    name: 'Decorative Lamp',
    nameAr: 'مصباح ديكوري',
    description: 'Modern decorative lamp for ambient lighting.',
    descriptionAr: 'مصباح ديكوري عصري للإضاءة المحيطة.',
    price: 45,
    inventory: 30,
    category: 'Decor',
    images: ['https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800'],
  },
];

// ============================================
// Seed Functions
// ============================================

async function seedSuperAdmin() {
  console.log('Creating super admin user...');

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error(
      'ADMIN_PASSWORD environment variable is required for seeding. Set it before running the seed script.'
    );
  }
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@ebda.app';

  const existingAdmin = await prisma.user.findFirst({
    where: { role: 'super_admin' },
  });

  if (existingAdmin) {
    console.log('Super admin already exists, ensuring mfaEnabled=true...');
    // Ensure the existing admin has mfaEnabled=true so integration tests can
    // access MFA-gated routes (requireMfaEnrolled middleware checks this flag).
    if (!existingAdmin.mfaEnabled) {
      return prisma.user.update({
        where: { id: existingAdmin.id },
        data: { mfaEnabled: true },
      });
    }
    return existingAdmin;
  }

  const admin = await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      firstName: 'Super',
      lastName: 'Admin',
      role: 'super_admin',
      emailVerified: true,
      language: 'en',
      // MFA gate (requireMfaEnrolled) blocks super_admin on all protected routes
      // unless mfaEnabled=true. The seeded CI admin must pass through so that
      // integration tests (api.test, feature-flag-enforcement, lifecycle-events)
      // can access /stores and /admin/stores endpoints without 403 MFA_SETUP_REQUIRED.
      mfaEnabled: true,
    },
  });

  console.log(`Created super admin (${admin.id})`);
  return admin;
}

async function seedDemoStore(ownerId: string) {
  console.log('Creating demo store...');

  const existingStore = await prisma.store.findFirst({
    where: { slug: 'demo-store' },
  });

  if (existingStore) {
    console.log('Demo store already exists, skipping...');
    return existingStore;
  }

  const store = await prisma.store.create({
    data: {
      name: 'Demo Store',
      nameAr: 'المتجر التجريبي',
      slug: 'demo-store',
      ownerId,
      status: 'active',
      plan: 'professional',
      description: 'A demo store showcasing the platform features',
      descriptionAr: 'متجر تجريبي يعرض ميزات المنصة',
      currency: REGION.currency,
      template: 'qamar',
      theme: {
        primaryColor: '210 9% 4%', // Ebda night (Ruling D1016-ORANGE-1)
        primaryForeground: '0 0% 100%',
        secondaryColor: '220 14% 96%',
        secondaryForeground: '220 9% 46%',
        fontFamily: 'modern',
        borderRadius: 'lg',
      },
      socialLinks: {
        instagram: 'https://instagram.com/demo',
        twitter: 'https://twitter.com/demo',
        whatsapp: '+20-101-234-5678',
      },
      email: 'contact@demostore.com',
      phone: '+20 101 234 5678',
      phoneAr: '+٢٠ ١٠١ ٢٣٤ ٥٦٧٨',
      whatsapp: '+201012345678',
      address: 'Cairo, Egypt',
      addressAr: 'القاهرة، مصر',
      announcementBar: {
        enabled: true,
        text: 'Free shipping on orders over 2,500 EGP!',
        textAr: 'شحن مجاني للطلبات فوق 2,500 ج.م!',
        bgColor: '210 9% 4%',
        textColor: '0 0% 100%',
      },
      metaTitle: 'Demo Store - Quality Products',
      metaTitleAr: 'المتجر التجريبي - منتجات عالية الجودة',
      metaDescription: 'Shop the best products at Demo Store',
      metaDescriptionAr: 'تسوق أفضل المنتجات في المتجر التجريبي',
      marketingPixels: {},
    },
  });

  console.log(`Created demo store: ${store.name}`);
  return store;
}

async function seedCategories(storeId: string) {
  console.log('Creating categories...');

  const existingCategories = await prisma.category.count({
    where: { storeId },
  });

  if (existingCategories > 0) {
    console.log('Categories already exist, skipping...');
    return;
  }

  for (const catData of DEMO_CATEGORIES) {
    const parentCategory = await prisma.category.create({
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

    for (const child of catData.children || []) {
      await prisma.category.create({
        data: {
          storeId,
          name: child.name,
          nameAr: child.nameAr,
          slug: generateSlug(child.name),
          parentId: parentCategory.id,
          isActive: true,
        },
      });
    }
  }

  console.log('Categories created successfully');
}

async function seedProducts(storeId: string) {
  console.log('Creating products...');

  const existingProducts = await prisma.product.count({
    where: { storeId },
  });

  if (existingProducts > 0) {
    console.log('Products already exist, skipping...');
    return;
  }

  // Get all categories
  const categories = await prisma.category.findMany({
    where: { storeId },
  });

  const categoryMap = new Map(categories.map(c => [c.name, c.id]));

  for (const productData of DEMO_PRODUCTS) {
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
        featured: productData.featured || false,
        isNew: productData.isNew || false,
        sku: `SKU-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`.toUpperCase(),
      },
    });

    // Add images
    for (let i = 0; i < productData.images.length; i++) {
      await prisma.productImage.create({
        data: {
          productId: product.id,
          url: productData.images[i],
          alt: productData.name,
          position: i,
        },
      });
    }

    // Link to category
    if (categoryId) {
      await prisma.productCategory.create({
        data: {
          productId: product.id,
          categoryId,
        },
      });
    }
  }

  console.log('Products created successfully');
}

async function seedDemoCustomers(storeId: string) {
  console.log('Creating demo customers...');

  const existingCustomers = await prisma.customer.count({
    where: { storeId },
  });

  if (existingCustomers > 0) {
    console.log('Customers already exist, skipping...');
    return;
  }

  const customers = [
    { firstName: 'Ahmed', lastName: 'Hassan', email: 'ahmed@example.com', phone: '+201001234567' },
    {
      firstName: 'Fatima',
      lastName: 'Mahmoud',
      email: 'fatima@example.com',
      phone: '+201112345678',
    },
    {
      firstName: 'Mohammed',
      lastName: 'Ibrahim',
      email: 'mohammed@example.com',
      phone: '+201223456789',
    },
    { firstName: 'Sara', lastName: 'Salem', email: 'sara@example.com', phone: '+201004567890' },
    {
      firstName: 'Khalid',
      lastName: 'Farouk',
      email: 'khalid@example.com',
      phone: '+201515678901',
    },
  ];

  for (const customer of customers) {
    await prisma.customer.create({
      data: {
        storeId,
        ...customer,
        totalOrders: Math.floor(Math.random() * 10),
        totalSpent: priceInFils(Math.floor(Math.random() * 500)),
      },
    });
  }

  console.log('Demo customers created successfully');
}

async function seedPaymentConfig(storeId: string) {
  console.log('Creating payment configurations...');

  const existingConfigs = await prisma.paymentConfig.count({
    where: { storeId },
  });

  if (existingConfigs > 0) {
    console.log('Payment configs already exist, skipping...');
    return;
  }

  // Create a demo Paymob payment config (disabled by default)
  await prisma.paymentConfig.create({
    data: {
      storeId,
      provider: 'paymob',
      isEnabled: false,
      testMode: true,
      apiKey: 'pk_test_demo',
      secretKey: 'sk_test_demo',
    },
  });

  console.log('Payment configurations created');
}

async function seedCoupons(storeId: string) {
  console.log('Creating demo coupons...');

  const existingCoupons = await prisma.coupon.count({
    where: { storeId },
  });

  if (existingCoupons > 0) {
    console.log('Coupons already exist, skipping...');
    return;
  }

  const coupons = [
    {
      code: 'WELCOME10',
      name: 'Welcome Discount',
      nameAr: 'خصم الترحيب',
      type: 'percentage' as const,
      value: 10,
      description: '10% off for new customers',
      descriptionAr: 'خصم 10% للعملاء الجدد',
      usageLimit: 100,
    },
    {
      code: 'SAVE500',
      name: 'Save 500 EGP',
      nameAr: 'وفر 500 ج.م',
      type: 'fixed' as const,
      value: priceInFils(5),
      description: '500 EGP off your order',
      descriptionAr: 'خصم 500 ج.م على طلبك',
      minOrderAmount: priceInFils(30),
    },
    {
      code: 'FREESHIP',
      name: 'Free Shipping',
      nameAr: 'شحن مجاني',
      type: 'free_shipping' as const,
      value: 0,
      description: 'Free shipping on any order',
      descriptionAr: 'شحن مجاني على أي طلب',
    },
  ];

  const futureDate = new Date();
  futureDate.setMonth(futureDate.getMonth() + 6);

  for (const coupon of coupons) {
    await prisma.coupon.create({
      data: {
        storeId,
        ...coupon,
        isActive: true,
        expiresAt: futureDate,
      },
    });
  }

  console.log('Demo coupons created successfully');
}

// ============================================
// Main Seed Function
// ============================================

async function main() {
  console.log('🌱 Starting database seed...\n');

  try {
    // Create super admin
    const admin = await seedSuperAdmin();

    // Create demo store
    const store = await seedDemoStore(admin.id);

    // Seed store data
    await seedCategories(store.id);
    await seedProducts(store.id);
    await seedDemoCustomers(store.id);
    await seedPaymentConfig(store.id);
    await seedCoupons(store.id);

    console.log('\n✅ Database seeded successfully!');
    console.log('\n📝 Super admin created with ADMIN_EMAIL and ADMIN_PASSWORD from environment.');
    console.log('\n🏪 Demo store: demo-store');
  } catch (error) {
    console.error('❌ Seed failed:', error);
    throw error;
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
