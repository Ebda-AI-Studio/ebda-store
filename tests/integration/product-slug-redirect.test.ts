/**
 * Integration test for Task 4: ProductService.update captures slug renames
 * as SlugRedirect rows.
 *
 * Exercises the real ProductService against the real DB (no mocked prisma),
 * wrapped in runInTenantContext to mirror the production RLS path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma, runInTenantContext, SlugEntityType } from '@force/database';
import { ProductService } from '../../apps/api/src/services/product.service';

const EMAIL = `product-slug-redirect-test-${Date.now()}@example.test`;
let STORE = '';
let userId = '';
let productId = '';

describe('ProductService.update slug redirect capture', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: 'hashed',
        firstName: 'Product',
        lastName: 'SlugRedirect',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;

    const store = await prisma.store.create({
      data: {
        name: 'Product Slug Redirect Test Store',
        slug: `product-slug-redirect-test-store-${Date.now()}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    STORE = store.id;
  });

  afterAll(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
    await prisma.product.deleteMany({ where: { storeId: STORE } });
    await prisma.store.deleteMany({ where: { id: STORE } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.slugRedirect.deleteMany({ where: { storeId: STORE } });
    await prisma.product.deleteMany({ where: { storeId: STORE } });

    const product = await runInTenantContext(STORE, () =>
      ProductService.create(STORE, {
        name: 'Raw Pecan',
        price: 1000,
        slug: 'raw-pecan-2636297',
      })
    );
    productId = product.id;
  });

  it('renaming a product slug records a PRODUCT redirect', async () => {
    await runInTenantContext(STORE, () =>
      ProductService.update(STORE, productId, { slug: 'raw-pecan' })
    );

    const row = await prisma.slugRedirect.findFirst({
      where: { storeId: STORE, entityType: SlugEntityType.PRODUCT, fromSlug: 'raw-pecan-2636297' },
    });
    expect(row?.toSlug).toBe('raw-pecan');
  });

  it('updating a product without changing the slug creates no redirect row', async () => {
    await runInTenantContext(STORE, () =>
      ProductService.update(STORE, productId, { name: 'Raw Pecan Deluxe' })
    );

    const count = await prisma.slugRedirect.count({
      where: { storeId: STORE, entityType: SlugEntityType.PRODUCT },
    });
    expect(count).toBe(0);
  });
});
