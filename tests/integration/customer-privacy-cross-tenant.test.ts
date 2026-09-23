/**
 * Cross-tenant scoping for merchant-initiated customer erasure/export
 * (integration)
 *
 * `POST /stores/:storeId/customers/:customerId/erase` and
 * `GET /stores/:storeId/customers/:customerId/export` let a merchant fulfil
 * a data-subject request for one of ITS OWN shoppers. The single most
 * important property of both routes is that a merchant can never act on, or
 * even detect the existence of, a shopper belonging to another store —
 * `resolveStoreCustomerOrThrow` (`apps/api/src/routes/customers.routes.ts`)
 * is the one chokepoint both routes share for that check, so this test
 * exercises it directly at the application layer, the same pattern
 * `tests/integration/accounting-cross-tenant.test.ts` and
 * `tests/integration/tenant-isolation.test.ts` use for
 * `OrderService.getById` / `createAdjustment`.
 *
 * Every failure mode below must be indistinguishable from the outside: "no
 * such id", "that id belongs to another store", and "that id is a staff/
 * admin account, not a customer" all return the SAME generic 404 — anything
 * else would let a merchant enumerate ids across tenants by probing this
 * endpoint with guessed UUIDs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withRlsBypass } from '@force/database';
import { resolveStoreCustomerOrThrow } from '../../apps/api/src/routes/customers.routes';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('merchant customer erase/export refuses cross-tenant ids', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;

  let storeAId: string;
  let storeBId: string;
  let customerOfStoreBId: string;
  let staffOfStoreAId: string;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const ownerA = await tx.user.create({
        data: {
          email: `cpxt-owner-a-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'CPXT',
          lastName: 'OwnerA',
        },
      });
      const storeA = await tx.store.create({
        data: {
          name: 'cpxt-store-a',
          slug: `cpxt-store-a-${suffix}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: ownerA.id,
        },
      });
      storeAId = storeA.id;

      const ownerB = await tx.user.create({
        data: {
          email: `cpxt-owner-b-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'CPXT',
          lastName: 'OwnerB',
        },
      });
      const storeB = await tx.store.create({
        data: {
          name: 'cpxt-store-b',
          slug: `cpxt-store-b-${suffix}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: ownerB.id,
        },
      });
      storeBId = storeB.id;

      // The victim: a real customer of store B.
      const customerB = await tx.user.create({
        data: {
          email: `cpxt-customer-b-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'customer',
          storeId: storeBId,
          firstName: 'Victim',
          lastName: 'Shopper',
        },
      });
      customerOfStoreBId = customerB.id;

      // A non-customer row scoped to store A itself — must still 404
      // (eraseAccount/exportAccount are customer-only; the resolver should
      // refuse before ever calling them).
      const staffA = await tx.user.create({
        data: {
          email: `cpxt-staff-a-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'staff',
          storeId: storeAId,
          firstName: 'Staff',
          lastName: 'MemberA',
        },
      });
      staffOfStoreAId = staffA.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.user.deleteMany({ where: { email: { startsWith: 'cpxt-' } } }).catch(() => {});
      await tx.store.deleteMany({ where: { slug: { startsWith: 'cpxt-' } } }).catch(() => {});
    });
  });

  it('refuses store A acting on store B’s real customer id (cross-tenant)', async () => {
    await expect(resolveStoreCustomerOrThrow(storeAId, customerOfStoreBId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('refuses a GUESSED id that happens to be a well-formed UUID but does not exist', async () => {
    await expect(
      resolveStoreCustomerOrThrow(storeAId, '00000000-0000-4000-8000-000000000000')
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('refuses a non-UUID id without ever querying the database', async () => {
    await expect(resolveStoreCustomerOrThrow(storeAId, 'not-a-uuid')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('refuses a staff/admin account even when it belongs to the CALLING store', async () => {
    await expect(resolveStoreCustomerOrThrow(storeAId, staffOfStoreAId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('the cross-tenant 404 is IDENTICAL to the not-found 404 (no enumeration signal)', async () => {
    const crossTenant = await resolveStoreCustomerOrThrow(storeAId, customerOfStoreBId).catch(
      e => e
    );
    const notFound = await resolveStoreCustomerOrThrow(
      storeAId,
      '00000000-0000-4000-8000-000000000000'
    ).catch(e => e);
    expect(crossTenant.statusCode).toBe(notFound.statusCode);
    expect(crossTenant.code).toBe(notFound.code);
    expect(crossTenant.message).toBe(notFound.message);
  });

  it('still resolves a store’s OWN customer (control)', async () => {
    const resolved = await resolveStoreCustomerOrThrow(storeBId, customerOfStoreBId);
    expect(resolved.id).toBe(customerOfStoreBId);
    expect(resolved.storeId).toBe(storeBId);
  });
});
