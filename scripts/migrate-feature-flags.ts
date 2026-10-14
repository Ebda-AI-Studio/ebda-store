import { createPrismaClient } from '@ebda/database';

const prisma = createPrismaClient({
  connectionString: process.env.DATABASE_URL ?? '',
  role: 'owner',
});

async function migrate() {
  const stores = await prisma.store.findMany({
    select: { id: true, taxEnabled: true, loyaltyEnabled: true, pwaEnabled: true },
  });

  for (const store of stores) {
    const features = [];
    if (store.taxEnabled)
      features.push({ storeId: store.id, featureKey: 'tax', enabled: true, enabledAt: new Date() });
    if (store.loyaltyEnabled)
      features.push({
        storeId: store.id,
        featureKey: 'loyalty',
        enabled: true,
        enabledAt: new Date(),
      });
    if (store.pwaEnabled)
      features.push({ storeId: store.id, featureKey: 'pwa', enabled: true, enabledAt: new Date() });

    for (const f of features) {
      await prisma.storeFeature.upsert({
        where: { storeId_featureKey: { storeId: f.storeId, featureKey: f.featureKey } },
        create: f,
        update: { enabled: f.enabled, enabledAt: f.enabledAt },
      });
    }
  }
  console.log(`Migrated ${stores.length} stores`);
}

migrate().then(() => prisma.$disconnect());
