/**
 * One-off: flip the wadyaljuz PLP product-card frame colour to the brand
 * primary token. The store had a saved productCardDefaults.cardFrameColor of
 * white (invisible on the light page), masking the code-default primary frame.
 *
 * Dry-run by default (prints current state). Pass --apply to write.
 * Run on PROD:  railway run npx tsx packages/database/prisma/flip-card-frame-primary.ts --apply
 */
import { createPrismaClient } from '../src/client';

const prisma = createPrismaClient({
  connectionString: process.env.DATABASE_URL ?? '',
  role: 'owner',
});
const APPLY = process.argv.includes('--apply');

async function main() {
  const store = await prisma.store.findFirst({
    where: {
      OR: [{ domain: 'wadyaljuz.com' }, { slug: 'wadyaljuz' }, { slug: { contains: 'wady' } }],
    },
    select: { id: true, name: true, slug: true, domain: true, layoutSettings: true },
  });

  if (!store) {
    console.error('wadyaljuz store not found');
    process.exit(1);
  }

  const layout = (store.layoutSettings ?? {}) as Record<string, any>;
  const pcd = (layout.productCardDefaults ?? {}) as Record<string, any>;

  console.log('Store:', store.id, store.name, store.slug, store.domain);
  console.log('Current productCardDefaults:', JSON.stringify(pcd, null, 2));

  if (!APPLY) {
    console.log(
      '\n[dry-run] would set cardFrameColor = "token:primary" (showCardFrame=true). Pass --apply to write.'
    );
    return;
  }

  const nextLayout = {
    ...layout,
    productCardDefaults: {
      ...pcd,
      showCardFrame: true,
      cardFrameColor: 'token:primary',
    },
  };

  await prisma.store.update({
    where: { id: store.id },
    data: { layoutSettings: nextLayout as unknown as object },
  });

  console.log('\n[applied] cardFrameColor -> token:primary, showCardFrame -> true');
  console.log('New productCardDefaults:', JSON.stringify(nextLayout.productCardDefaults, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
