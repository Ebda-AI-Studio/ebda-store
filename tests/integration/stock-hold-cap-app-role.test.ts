/** Atomic admission under the actual non-bypass runtime role, on local/CI Postgres. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, prisma, runWithRequestDb, withStore } from '@force/database';
import { assertStockHoldCapNotExceeded } from '@api/lib/stock-hold-cap';
import { hasDb, seedBundleStore } from '../helpers/bundle-fixtures';

const ownerUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const appUrl = () => {
  const url = new URL(ownerUrl);
  url.username = 'ebda_app';
  url.password = 'ci-only-app-pw';
  return url.toString();
};
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 1 }), fn);

describe.skipIf(!hasDb)('stock-hold admission as strict ebda_app', () => {
  let storeId: string;
  let otherStoreId: string;
  beforeAll(async () => {
    await prisma.$executeRawUnsafe("ALTER ROLE ebda_app WITH LOGIN PASSWORD 'ci-only-app-pw'");
    storeId = (await seedBundleStore(`hold-app-${randomUUID()}`)).storeId;
    otherStoreId = (await seedBundleStore(`hold-other-${randomUUID()}`)).storeId;
  });
  async function admit(tenant: string) {
    return asApp(() =>
      withStore(tenant, async tx => {
        const [role] = await tx.$queryRaw<
          Array<{ role: string; bypass: boolean; superuser: boolean }>
        >`
        SELECT current_user::text AS role, rolbypassrls AS bypass, rolsuper AS superuser
        FROM pg_roles WHERE rolname = current_user`;
        expect(role).toEqual({ role: 'ebda_app', bypass: false, superuser: false });
        await assertStockHoldCapNotExceeded(tx, tenant, 'cod', {
          phone: '+201099999999',
          email: ' App@Example.com ',
          ip: '203.0.113.90',
        });
        return tx.order.create({
          data: {
            storeId: tenant,
            orderNumber: `HOLD-${randomUUID()}`,
            subtotal: 1000,
            total: 1000,
            shippingAddress: { phone: '+201099999999', email: 'app@example.com' },
            billingAddress: {},
            checkoutIp: '203.0.113.90',
            manualHoldAdmitted: true,
          },
        });
      })
    );
  }

  it('admits exactly two overlapping requests and isolates the same signals in another tenant', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => admit(storeId)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason.code).toBe('TOO_MANY_OPEN_HOLDS');
    }
    await expect(admit(otherStoreId)).resolves.toMatchObject({ manualHoldAdmitted: true });
    const orders = await asApp(() =>
      withStore(storeId, tx => tx.order.findMany({ where: { storeId } }))
    );
    expect(orders).toHaveLength(2);
    const invisible = await asApp(() =>
      withStore(
        otherStoreId,
        tx => tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM orders WHERE store_id = ${storeId}`
      )
    );
    expect(invisible[0].count).toBe(0n);
  });
});
