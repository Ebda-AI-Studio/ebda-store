/**
 * Review Focus 2 / Ruling B2B-2: a typed phone or email is never a price identity. Real Postgres as `ebda_app`, the
 * real PriceResolver and the real FeatureService (docs/plans/2026-10-21-b2b-wholesale.md, Task 2).
 *
 * The HTTP half of "guest checkout with a wholesaler's phone is charged retail" lands with the cart/order wiring in
 * Task 3 (b2b-price-parity.test.ts); this file proves the resolver can only ever be handed the AUTHENTICATED user id and
 * what it then does with every way an identity can fail to be that wholesaler.
 * Retry-safe: fixtures keyed on a per-run suffix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TextFallbackClient } from '../../packages/database/src/client';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  type AppPrismaClient,
} from '@ebda/database';
import { PriceResolver } from '../../apps/api/src/services/price-resolver.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const RUN = `b2bid-${crypto.randomBytes(4).toString('hex')}`;
const WHOLESALE_EMAIL = `${RUN}-buyer@test.com`;
const WHOLESALE_PHONE = '+201055550001';

let owner: AppPrismaClient;
const makeApp = (): AppPrismaClient => {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: u.toString(), max: 2, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  }) as unknown as AppPrismaClient;
};
/** Resolve one line the way a request would: as ebda_app, inside the store's tenant context. */
function price(storeId: string, buyerUserId: string | null, qty = 1) {
  return runWithRequestDb(makeApp, () =>
    runInTenantContext(storeId, async () => {
      const r = await PriceResolver.forBuyer(storeId, buyerUserId);
      return r.priceLine({ id: ids.product!, price: 10_000 }, null, qty);
    })
  );
}

const ids = {} as Record<string, string>;

async function cleanup() {
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${RUN}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${RUN}%'`);
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await owner.$executeRawUnsafe(`ALTER ROLE ebda_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
  await cleanup();
  const user = (tag: string, o: Record<string, unknown> = {}) =>
    owner.user.create({
      data: {
        email: `${RUN}-${tag}@test.com`,
        passwordHash: 'x',
        firstName: tag,
        lastName: 'T',
        role: 'customer',
        emailVerified: true,
        ...o,
      } as never,
    });
  const merchant = await user('merchant', { role: 'store_admin', storeId: null });
  const store = await owner.store.create({
    data: { slug: `${RUN}-s`, name: 'S', ownerId: merchant.id },
  });
  const otherStore = await owner.store.create({
    data: { slug: `${RUN}-o`, name: 'O', ownerId: merchant.id },
  });
  // The wholesaler's account email is the identity link to the Customer row the merchant put in the group.
  const wholesaler = await owner.user.create({
    data: {
      email: WHOLESALE_EMAIL,
      passwordHash: 'x',
      firstName: 'W',
      lastName: 'T',
      role: 'customer',
      emailVerified: true,
      storeId: store.id,
      phone: WHOLESALE_PHONE,
    },
  });
  const group = await owner.customerGroup.create({
    data: {
      storeId: store.id,
      name: 'Wholesale',
      pricingMode: 'percent_off',
      discountBps: 2_000,
      isWholesale: true,
    },
  });
  const otherGroup = await owner.customerGroup.create({
    data: {
      storeId: otherStore.id,
      name: 'Wholesale',
      pricingMode: 'percent_off',
      discountBps: 5_000,
    },
  });
  await owner.customer.create({
    data: {
      storeId: store.id,
      email: WHOLESALE_EMAIL,
      phone: WHOLESALE_PHONE,
      firstName: 'W',
      lastName: 'T',
      groupId: group.id,
    },
  });
  const product = await owner.product.create({
    data: { storeId: store.id, name: 'p', slug: `${RUN}-p`, price: 10_000 },
  });
  await owner.productPriceTier.create({
    data: { storeId: store.id, productId: product.id, minQty: 10, priceMinor: 9_000 },
  });
  await owner.storeFeature.create({
    data: { storeId: store.id, featureKey: 'b2b.wholesale', enabled: true },
  });

  Object.assign(ids, {
    store: store.id,
    otherStore: otherStore.id,
    wholesaler: wholesaler.id,
    group: group.id,
    otherGroup: otherGroup.id,
    product: product.id,
    merchant: merchant.id,
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('Ruling B2B-2: only the authenticated, verified account holder gets the group price', () => {
  it('the verified wholesaler gets 20% off', async () => {
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({
      unitMinor: 8_000,
      source: 'group',
    });
  });

  it('a guest is charged retail, and quantity alone only reaches the PUBLIC tier', async () => {
    expect(await price(ids.store!, null)).toMatchObject({ unitMinor: 10_000, source: 'base' });
    expect(await price(ids.store!, null, 10)).toMatchObject({ unitMinor: 9_000, source: 'tier' });
  });

  it("another customer account carrying the wholesaler's PHONE is charged retail (phone is never an identity)", async () => {
    const thief = await owner.user.create({
      data: {
        email: `${RUN}-thief@test.com`,
        passwordHash: 'x',
        firstName: 'T',
        lastName: 'T',
        role: 'customer',
        emailVerified: true,
        storeId: ids.store!,
        phone: WHOLESALE_PHONE,
      },
    });
    expect(await price(ids.store!, thief.id)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it("a case-variant of the wholesaler's email that was never VERIFIED is charged retail", async () => {
    const variant = await owner.user.create({
      data: {
        email: WHOLESALE_EMAIL.toUpperCase(),
        passwordHash: 'x',
        firstName: 'V',
        lastName: 'T',
        role: 'customer',
        emailVerified: false,
        storeId: ids.store!,
      },
    });
    expect(await price(ids.store!, variant.id)).toMatchObject({
      unitMinor: 10_000,
      source: 'base',
    });
  });

  it('a suspended or soft-deleted wholesaler account is charged retail', async () => {
    await owner.user.update({ where: { id: ids.wholesaler! }, data: { status: 'suspended' } });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({ source: 'base' });
    await owner.user.update({
      where: { id: ids.wholesaler! },
      data: { status: 'active', deletedAt: new Date() },
    });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({ source: 'base' });
    await owner.user.update({ where: { id: ids.wholesaler! }, data: { deletedAt: null } });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({ source: 'group' });
  });

  it('the same user id presented to ANOTHER store is charged retail (accounts are store-scoped)', async () => {
    expect(await price(ids.otherStore!, ids.wholesaler!)).toMatchObject({
      unitMinor: 10_000,
      source: 'base',
    });
  });

  it('a Customer row pointing at a group of ANOTHER store resolves to retail (cross-store group id)', async () => {
    const x = await owner.user.create({
      data: {
        email: `${RUN}-x@test.com`,
        passwordHash: 'x',
        firstName: 'X',
        lastName: 'T',
        role: 'customer',
        emailVerified: true,
        storeId: ids.store!,
      },
    });
    // The FK permits a cross-store group id; the loader must not.
    await owner.customer.create({
      data: {
        storeId: ids.store!,
        email: x.email,
        firstName: 'X',
        lastName: 'T',
        groupId: ids.otherGroup!,
      },
    });
    expect(await price(ids.store!, x.id)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('a non-customer role (the merchant) never gets a customer group price', async () => {
    expect(await price(ids.store!, ids.merchant!)).toMatchObject({ source: 'base' });
  });

  it('RF10: deactivating the group, or unassigning the customer, returns the wholesaler to retail immediately', async () => {
    await owner.customerGroup.update({ where: { id: ids.group! }, data: { isActive: false } });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({
      unitMinor: 10_000,
      source: 'base',
    });
    await owner.customerGroup.update({ where: { id: ids.group! }, data: { isActive: true } });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({ source: 'group' });
    await owner.customer.updateMany({
      where: { storeId: ids.store!, email: WHOLESALE_EMAIL },
      data: { groupId: null },
    });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({ source: 'base' });
    await owner.customer.updateMany({
      where: { storeId: ids.store!, email: WHOLESALE_EMAIL },
      data: { groupId: ids.group! },
    });
  });

  it('RF13: with the feature off the wholesaler AND the public tier both pay retail', async () => {
    await owner.storeFeature.update({
      where: { storeId_featureKey: { storeId: ids.store!, featureKey: 'b2b.wholesale' } },
      data: { enabled: false },
    });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({
      unitMinor: 10_000,
      source: 'base',
    });
    expect(await price(ids.store!, null, 10)).toMatchObject({ unitMinor: 10_000, source: 'base' });
    await owner.storeFeature.update({
      where: { storeId_featureKey: { storeId: ids.store!, featureKey: 'b2b.wholesale' } },
      data: { enabled: true },
    });
    expect(await price(ids.store!, ids.wholesaler!)).toMatchObject({ source: 'group' });
  });
});
