/**
 * RFM ⇄ Customers-page key unification (analytics audit 2026-09-30 §4,
 * related to issue 2051).
 *
 * The rollup used to key a guest as `GUEST:sha256("<email>:<phone>")` while
 * the Customers list keyed the same guest by plain email/phone, so no segment
 * could ever resolve to a list row — and on a guest-only store (demo-store:
 * 81 snapshots, all guests) the segment drill-down was empty by construction.
 *
 * Asserts, on a real Postgres:
 *  1. a guest's snapshot key is `rfmKeyFor(customerKeyOf(order))`, one row per
 *     Customers-page customer (one email + two phones = ONE row, not two);
 *  2. `segmentsForCustomers` resolves that snapshot to the list row;
 *  3. the nightly run's stale-row sweep removes a pre-change-format row, so
 *     the first run after deploy converges without a manual data fix, and
 *     never touches another store's rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { runInStoreScope, withRlsBypass } from '@ebda/database';
import { runRfmRollup } from '@api/services/accounting/analytics-rollup.service';
import { rfmKeyFor } from '@api/lib/customer-key';
import { aggregateCustomers, segmentsForCustomers } from '@api/services/customer-aggregate.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)('RFM guest key = Customers-page key', () => {
  const suffix = uid();
  const guestEmail = `Rfm.Guest.${suffix}@Example.com`;
  let storeId = '';
  let otherStoreId = '';
  let registeredId = '';
  const legacyKey = `GUEST:${createHash('sha256').update(`${guestEmail.toLowerCase()}:+96550001111`).digest('hex')}`;
  const otherStoreKey = `GUEST:other-${suffix}`;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `rfm-owner-${suffix}@example.com`,
          passwordHash: 'x',
          role: 'store_admin',
          firstName: 'O',
          lastName: 'W',
        },
      });
      const mkStore = (s: string) =>
        tx.store.create({
          data: {
            name: `rfm ${s}`,
            slug: `rfm-${s}`,
            template: 'qamar',
            currency: 'EGP',
            ownerId: owner.id,
            status: 'active',
          },
        });
      storeId = (await mkStore(`a-${suffix}`)).id;
      otherStoreId = (await mkStore(`b-${suffix}`)).id;

      const reg = await tx.user.create({
        data: {
          email: `rfm-reg-${suffix}@example.com`,
          passwordHash: 'x',
          role: 'customer',
          storeId,
          firstName: 'R',
          lastName: 'G',
        },
      });
      registeredId = reg.id;

      const order = (n: number, data: Record<string, unknown>) =>
        tx.order.create({
          data: {
            storeId,
            orderNumber: `RFM-${suffix}-${n}`,
            status: 'delivered',
            paymentStatus: 'paid',
            subtotal: 10_000,
            total: 10_000,
            billingAddress: {},
            ...data,
          } as any,
        });
      await order(1, { shippingAddress: { email: guestEmail, phone: '+96550001111' } });
      await order(2, { shippingAddress: { email: guestEmail, phone: '+96550002222' } });
      await order(3, { customerId: registeredId, shippingAddress: {} });

      // A row written under the OLD guest key format, and one in another store.
      const snap = (sid: string, customerId: string) => ({
        storeId: sid,
        customerId,
        isGuest: true,
        recencyDays: 1,
        frequencyOrders: 1,
        monetaryFils: 1,
        rfmScore: 111,
        segment: 'lost' as const,
      });
      await tx.customerRfmSnapshot.createMany({
        data: [snap(storeId, legacyKey), snap(otherStoreId, otherStoreKey)],
      });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.order.deleteMany({ where: { storeId: { in: [storeId, otherStoreId] } } });
      await tx.user.deleteMany({ where: { storeId } });
      await tx.store.deleteMany({ where: { id: { in: [storeId, otherStoreId] } } });
    });
  });

  it('keys the guest by the shared helper — one row per Customers-page customer', async () => {
    await withRlsBypass(() => runRfmRollup(storeId));
    const rows = await withRlsBypass(tx =>
      tx.customerRfmSnapshot.findMany({
        where: { storeId },
        select: { customerId: true, isGuest: true },
      })
    );
    const keys = rows.map(r => r.customerId).sort();
    expect(keys).toEqual([registeredId, rfmKeyFor(guestEmail.toLowerCase(), true)].sort());
    // No plain contact at rest.
    expect(JSON.stringify(rows)).not.toContain('@');
  });

  it('sweeps the pre-change-format row, and only in this store', async () => {
    const legacy = await withRlsBypass(tx =>
      tx.customerRfmSnapshot.count({ where: { storeId, customerId: legacyKey } })
    );
    const other = await withRlsBypass(tx =>
      tx.customerRfmSnapshot.count({ where: { storeId: otherStoreId, customerId: otherStoreKey } })
    );
    expect(legacy).toBe(0);
    expect(other).toBe(1);
  });

  it("resolves every snapshot to a Customers-page row (the segment drill-down's join)", async () => {
    const { customers } = await withRlsBypass(() => aggregateCustomers(storeId));
    // the routes and the MCP tools call it inside the request's tenant context; a direct call needs the same scope
    const segmentOf = await runInStoreScope(storeId, () =>
      segmentsForCustomers(storeId, customers)
    );
    const guestRow = customers.find(c => c.isGuest)!;
    expect(guestRow.id).toBe(guestEmail.toLowerCase());
    expect(segmentOf.has(guestRow.id)).toBe(true);
    expect(segmentOf.has(registeredId)).toBe(true);
    expect(segmentOf.size).toBe(2);
  });
});
