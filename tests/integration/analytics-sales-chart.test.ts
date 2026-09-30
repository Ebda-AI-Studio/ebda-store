/**
 * The sales-chart SQL buckets on the viewer's calendar day, against real
 * Postgres (the unit test mocks $queryRaw, so it cannot prove the
 * `date_trunc(unit, created_at + offset)` statement itself is valid or
 * lines up with the JS zero-fill keys).
 *
 * An order at 2026-09-01T22:30Z is Sep 2, 01:30 in Kuwait (UTC+3). With the
 * Kuwait offset it must land in the `2026-09-02` bucket; bucketing by UTC day
 * (the old behaviour) put it on Sep 1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { AnalyticsService } from '../../apps/api/src/services/analytics.service';

const OWNER = '00000000-0000-0000-0000-0000000009a1';
let storeId: string;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function order(createdAt: string, total: number) {
  await prisma.order.create({
    data: {
      storeId,
      orderNumber: `SALES-${suffix}-${createdAt}`,
      status: 'confirmed',
      paymentStatus: 'paid',
      subtotal: total,
      tax: 0,
      shipping: 0,
      discount: 0,
      total,
      currency: 'KWD',
      shippingAddress: {},
      billingAddress: {},
      createdAt: new Date(createdAt),
    },
  });
}

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `sales-chart-${suffix}@x.test`,
      passwordHash: 'x',
      firstName: 'S',
      lastName: 'C',
    },
  });
  const s = await prisma.store.create({
    data: { name: `sales-chart-${suffix}`, slug: `sales-chart-${suffix}`, ownerId: OWNER },
  });
  storeId = s.id;
  await order('2026-09-01T22:30:00Z', 1000); // Sep 2 01:30 Kuwait
  await order('2026-09-02T10:00:00Z', 2000); // Sep 2 13:00 Kuwait
  await order('2026-03-10T10:00:00Z', 500); // March
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('AnalyticsService.getSalesChart against Postgres', () => {
  it('daily buckets follow the viewer offset (Kuwait)', async () => {
    const { sales, granularity } = await AnalyticsService.getSalesChart(
      storeId,
      'this_month',
      { startDate: new Date('2026-08-31T21:00:00Z'), endDate: new Date('2026-09-30T20:59:59Z') },
      180
    );
    expect(granularity).toBe('day');
    expect(sales).toHaveLength(30);
    const byDate = Object.fromEntries(sales.map(s => [s.date, s]));
    expect(byDate['2026-09-01']).toMatchObject({ revenue: 0, orders: 0 });
    expect(byDate['2026-09-02']).toMatchObject({ revenue: 3000, orders: 2 });
  });

  it('this_year → monthly buckets from the database', async () => {
    const { sales, granularity } = await AnalyticsService.getSalesChart(
      storeId,
      'this_year',
      { startDate: new Date('2025-12-31T21:00:00Z'), endDate: new Date('2026-09-30T20:59:59Z') },
      180
    );
    expect(granularity).toBe('month');
    expect(sales).toHaveLength(9);
    const byDate = Object.fromEntries(sales.map(s => [s.date, s]));
    expect(byDate['2026-03']).toMatchObject({ revenue: 500, orders: 1 });
    expect(byDate['2026-09']).toMatchObject({ revenue: 3000, orders: 2 });
  });

  it('weekly buckets key on the Monday the SQL truncates to', async () => {
    const { sales, granularity } = await AnalyticsService.getSalesChart(
      storeId,
      'last_90',
      { startDate: new Date('2026-07-02T21:00:00Z'), endDate: new Date('2026-09-30T20:59:59Z') },
      180
    );
    expect(granularity).toBe('week');
    const byDate = Object.fromEntries(sales.map(s => [s.date, s]));
    // Sep 2 2026 (Wed) is in the week starting Mon Aug 31.
    expect(byDate['2026-08-31']).toMatchObject({ revenue: 3000, orders: 2 });
    expect(sales.reduce((n, s) => n + s.orders, 0)).toBe(2);
  });
});
