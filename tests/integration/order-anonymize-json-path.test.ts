/**
 * Ruling ANON-JSONPATH-1 against REAL Postgres: the 5y order-anonymize candidate filter must select every order whose
 * shipping_address is not already `{"anonymized":true}` - path absent, false, JSON null at the path, and a whole-value JSON
 * null - and skip only the already-anonymized one. A bare `NOT { path, equals: true }` (the old form) SKIPS the
 * absent-path rows on Postgres (NULL three-valued logic), so the cron never matched a normal order. The old form is run
 * here as a negative control so this test cannot pass on a filter that has the bug.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, Prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { shippingAddressNotAnonymized } from '@api/lib/inngest/functions/order-anonymize-where';

const TAG = `anj-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
let storeId = '';
const ids: Record<string, string> = {};

const CASES: Record<string, Prisma.InputJsonValue | typeof Prisma.JsonNull> = {
  absentOtherKeys: { city: 'Cairo', phone: '010' },
  absentEmptyObject: {},
  presentTrue: { anonymized: true },
  presentFalse: { anonymized: false },
  pathJsonNull: { anonymized: null },
  wholeValueJsonNull: Prisma.JsonNull,
};

describe.skipIf(!hasDb)('order-anonymize candidate filter on a json path (real Postgres)', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${TAG}-o@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'A',
        lastName: 'J',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    storeId = (
      await prisma.store.create({
        data: { name: 'ANJ', slug: `${TAG}-s`, ownerId: owner.id, status: 'active' },
      })
    ).id;
    for (const [name, shippingAddress] of Object.entries(CASES)) {
      const o = await prisma.order.create({
        data: {
          storeId,
          orderNumber: `${TAG}-${name}`,
          subtotal: 100,
          total: 100,
          shippingAddress: shippingAddress as never,
          billingAddress: {},
        },
      });
      ids[name] = o.id;
    }
  });
  afterAll(async () => {
    await prisma.order.deleteMany({ where: { storeId } });
  });

  const select = async (where: Prisma.OrderWhereInput) =>
    (await prisma.order.findMany({ where: { storeId, ...where }, select: { id: true } }))
      .map(o => o.id)
      .sort();
  const expectIds = (...names: string[]) => names.map(n => ids[n]).sort();

  it('selects absent, false, path-JSON-null and whole-value-JSON-null; skips only present-true', async () => {
    expect(await select(shippingAddressNotAnonymized)).toEqual(
      expectIds(
        'absentOtherKeys',
        'absentEmptyObject',
        'presentFalse',
        'pathJsonNull',
        'wholeValueJsonNull'
      )
    );
  });

  it('negative control: the old bare NOT form skips the absent-path rows (the bug)', async () => {
    const old = await select({ NOT: { shippingAddress: { path: ['anonymized'], equals: true } } });
    expect(old).toEqual(expectIds('presentFalse', 'pathJsonNull'));
    expect(old).not.toContain(ids.absentOtherKeys);
  });
});
