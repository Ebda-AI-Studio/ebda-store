import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@forcemedia.com' },
    update: {},
    create: {
      email: 'admin@forcemedia.com',
      passwordHash: adminPassword,
      firstName: 'Admin',
      lastName: 'User',
      role: 'super_admin',
      emailVerified: true,
    },
  });
  console.log('✅ Created admin user:', admin.email);

  // Create demo customer
  const customerPassword = await bcrypt.hash('customer123', 12);
  const customer = await prisma.user.upsert({
    where: { email: 'customer@example.com' },
    update: {},
    create: {
      email: 'customer@example.com',
      passwordHash: customerPassword,
      firstName: 'John',
      lastName: 'Doe',
      role: 'customer',
      emailVerified: true,
    },
  });
  console.log('✅ Created demo customer:', customer.email);

  // Create demo store
  const store = await prisma.store.upsert({
    where: { slug: 'force-demo-store' },
    update: {},
    create: {
      name: 'Force Demo Store',
      slug: 'force-demo-store',
      ownerId: admin.id,
      status: 'active',
      settings: {
        currency: 'USD',
        timezone: 'America/New_York',
        locale: 'en-US',
        theme: 'default',
      },
    },
  });
  console.log('✅ Created demo store:', store.name);

  // Create categories
  const categories = await Promise.all([
    prisma.category.upsert({
      where: { storeId_slug: { storeId: store.id, slug: 'electronics' } },
      update: {},
      create: {
        storeId: store.id,
        name: 'Electronics',
        slug: 'electronics',
        description: 'Electronic devices and accessories',
      },
    }),
    prisma.category.upsert({
      where: { storeId_slug: { storeId: store.id, slug: 'accessories' } },
      update: {},
      create: {
        storeId: store.id,
        name: 'Accessories',
        slug: 'accessories',
        description: 'Tech accessories and peripherals',
      },
    }),
    prisma.category.upsert({
      where: { storeId_slug: { storeId: store.id, slug: 'wearables' } },
      update: {},
      create: {
        storeId: store.id,
        name: 'Wearables',
        slug: 'wearables',
        description: 'Smartwatches and fitness trackers',
      },
    }),
  ]);
  console.log('✅ Created categories:', categories.length);

  // Create products
  const products = [
    {
      name: 'Premium Wireless Headphones',
      slug: 'premium-wireless-headphones',
      description: 'High-quality wireless headphones with noise cancellation',
      price: 29900, // $299.00
      compareAtPrice: 34900,
      sku: 'HEADPHONES-001',
      inventory: 50,
      status: 'active' as const,
      featured: true,
      categorySlug: 'electronics',
    },
    {
      name: 'Smart Watch Pro',
      slug: 'smart-watch-pro',
      description: 'Advanced smartwatch with health monitoring features',
      price: 39900, // $399.00
      compareAtPrice: 44900,
      sku: 'WATCH-001',
      inventory: 30,
      status: 'active' as const,
      featured: true,
      categorySlug: 'wearables',
    },
    {
      name: 'USB-C Hub 7-in-1',
      slug: 'usb-c-hub-7-in-1',
      description: 'Multi-port USB-C hub for laptops',
      price: 7900, // $79.00
      sku: 'HUB-001',
      inventory: 100,
      status: 'active' as const,
      featured: false,
      categorySlug: 'accessories',
    },
    {
      name: 'Wireless Mechanical Keyboard',
      slug: 'wireless-mechanical-keyboard',
      description: 'Premium mechanical keyboard with RGB lighting',
      price: 14900, // $149.00
      compareAtPrice: 17900,
      sku: 'KEYBOARD-001',
      inventory: 45,
      status: 'active' as const,
      featured: true,
      categorySlug: 'accessories',
    },
    {
      name: 'Portable Bluetooth Speaker',
      slug: 'portable-bluetooth-speaker',
      description: 'Waterproof portable speaker with 20-hour battery life',
      price: 12900, // $129.00
      sku: 'SPEAKER-001',
      inventory: 60,
      status: 'active' as const,
      featured: false,
      categorySlug: 'electronics',
    },
    {
      name: 'Fitness Tracker Band',
      slug: 'fitness-tracker-band',
      description: 'Lightweight fitness tracker with heart rate monitoring',
      price: 9900, // $99.00
      compareAtPrice: 12900,
      sku: 'TRACKER-001',
      inventory: 80,
      status: 'active' as const,
      featured: true,
      categorySlug: 'wearables',
    },
  ];

  for (const productData of products) {
    const category = categories.find(c => c.slug === productData.categorySlug);
    const { categorySlug, ...data } = productData;

    const product = await prisma.product.upsert({
      where: { storeId_slug: { storeId: store.id, slug: data.slug } },
      update: {},
      create: {
        storeId: store.id,
        ...data,
        images: {
          create: [
            {
              url: `https://placehold.co/600x600/ff6e00/white?text=${encodeURIComponent(data.name)}`,
              alt: data.name,
              position: 0,
            },
          ],
        },
        categories: category
          ? {
              create: [{ categoryId: category.id }],
            }
          : undefined,
      },
    });
    console.log('✅ Created product:', product.name);
  }

  console.log('');
  console.log('🎉 Database seed completed!');
  console.log('');
  console.log('📋 Demo Credentials:');
  console.log('   Admin: admin@forcemedia.com / admin123');
  console.log('   Customer: customer@example.com / customer123');
  console.log('');
  console.log(`🏪 Demo Store ID: ${store.id}`);
}

main()
  .catch(e => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
