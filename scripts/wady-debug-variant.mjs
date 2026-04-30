import { prisma } from '@force/database';
const productId = '3d97db1f-22ed-4a74-b273-fbcb48a42fde';
const variantId = '22e2ed20-9ad9-4536-b071-f4713d549606';

const product = await prisma.product.findUnique({
  where: { id: productId },
  select: {
    id: true,
    sku: true,
    nameAr: true,
    name: true,
    storeId: true,
    deletedAt: true,
    hasVariants: true,
    variants: { select: { id: true, sku: true, title: true, titleAr: true, isActive: true } },
  },
});
console.log('Product:', JSON.stringify(product, null, 2));

const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
console.log('Variant by id:', JSON.stringify(variant, null, 2));

await prisma.$disconnect();
