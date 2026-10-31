/**
 * Guest-aware analytics (audit 2026-09-30, findings 2b/5/6).
 *
 * - `totalCustomers` counted registered `users` linked through
 *   `orders.customer_id`, which guest checkout leaves NULL: 0 on a store whose
 *   buyers are all guests while the Customers page listed dozens. It now uses
 *   the Customers page's key (user → email → phone → per-order guest), and the
 *   SQL twin must agree with the JS helper the page uses.
 * - `totalProfit` summed only lines with a cost and reported 0 when none had
 *   one; it must say "unknown" (null) and how many lines lack cost.
 * - `conversionRate` was a literal 0; it is views-based or null.
 *
 * The merchant MCP `admin_get_analytics` tool returns `getDashboardStats`
 * verbatim, so these assertions cover it too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, withRlsBypass, runInStoreScope } from '@ebda/database';
import { AnalyticsService } from '../../apps/api/src/services/analytics.service';
import { customerKeyOf } from '../../apps/api/src/lib/customer-key';
import { aggregateCustomers } from '../../apps/api/src/services/customer-aggregate.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

// The routes and the MCP tool call the service inside the request's tenant context; a direct call needs the same scope.
const dashboardStats = (storeId: string) =>
  runInStoreScope(storeId, () => AnalyticsService.getDashboardStats(storeId, range()));

const OWNER = '00000000-0000-0000-0000-0000000000f8';
const stores: string[] = [];
const users: string[] = [];

async function makeStore(label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await prisma.store.create({
    data: { name: `ak-${suffix}`, slug: `ak-${suffix}`, ownerId: OWNER },
  });
  stores.push(store.id);
  const product = await prisma.product.create({
    data: { storeId: store.id, name: 'P', slug: `p-${suffix}`, price: 1000, status: 'active' },
  });
  return { storeId: store.id, productId: product.id, suffix };
}

let n = 0;
async function order(
  storeId: string,
  productId: string,
  opts: {
    customerId?: string;
    email?: string;
    phone?: string;
    status?: 'pending' | 'cancelled' | 'delivered';
    lines?: Array<{ price: number; quantity: number; costPrice: number | null }>;
  }
) {
  n += 1;
  const lines = opts.lines ?? [{ price: 1000, quantity: 1, costPrice: null }];
  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const address: Record<string, string> = { firstName: 'G', lastName: 'B' };
  if (opts.email !== undefined) address.email = opts.email;
  if (opts.phone !== undefined) address.phone = opts.phone;
  return prisma.order.create({
    data: {
      storeId,
      orderNumber: `AK-${Date.now()}-${n}-${Math.random().toString(36).slice(2, 6)}`,
      customerId: opts.customerId ?? null,
      status: opts.status ?? 'delivered',
      paymentStatus: 'paid',
      subtotal: total,
      tax: 0,
      shipping: 0,
      discount: 0,
      total,
      currency: 'EGP',
      shippingAddress: address,
      billingAddress: address,
      items: {
        create: lines.map(l => ({
          productId,
          productName: 'P',
          quantity: l.quantity,
          price: l.price,
          total: l.price * l.quantity,
          costPrice: l.costPrice,
        })),
      },
    },
  });
}

const range = () => ({
  startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endDate: new Date(Date.now() + 60 * 60 * 1000),
});

let mixed: { storeId: string; productId: string };
let uncosted: { storeId: string; productId: string };
let zeroOrder: { storeId: string; productId: string };

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `ak-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'A',
      lastName: 'K',
    },
  });
  const u1 = await prisma.user.create({
    data: {
      email: `ak-buyer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'U',
    },
  });
  users.push(u1.id);

  mixed = await makeStore('mixed');
  const { storeId, productId } = mixed;
  // Registered buyer, twice — one customer. One costed line: (1000−400)×2.
  await order(storeId, productId, {
    customerId: u1.id,
    email: 'registered@example.test',
    lines: [{ price: 1000, quantity: 2, costPrice: 400 }],
  });
  await order(storeId, productId, { customerId: u1.id });
  // Guest by email, differing only in case — one customer. One uncosted line.
  await order(storeId, productId, {
    email: 'Guest.A@Example.test',
    lines: [{ price: 3000, quantity: 1, costPrice: null }],
  });
  await order(storeId, productId, {
    email: 'guest.a@example.test',
    lines: [{ price: 1000, quantity: 1, costPrice: 500 }],
  });
  // Guest by phone only (empty email falls through) — one customer.
  await order(storeId, productId, {
    email: '',
    phone: '96551230000',
    lines: [{ price: 1000, quantity: 1, costPrice: 500 }],
  });
  await order(storeId, productId, {
    phone: '96551230000',
    lines: [{ price: 1000, quantity: 1, costPrice: 500 }],
  });
  // Two guests with no contact at all — each its own customer.
  await order(storeId, productId, { lines: [{ price: 1000, quantity: 1, costPrice: 500 }] });
  await order(storeId, productId, { lines: [{ price: 1000, quantity: 1, costPrice: 500 }] });
  // A cancelled order: a customer on the Customers page, but not in the
  // period's sales stats.
  await order(storeId, productId, { email: 'cancelled@example.test', status: 'cancelled' });

  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  await prisma.funnelSnapshot.create({
    data: {
      storeId,
      periodDate: day,
      productViews: 200,
      cartsCreated: 0,
      cartItemsAdded: 0,
      checkoutsStarted: 0,
      ordersCompleted: 5,
      ordersAbandoned: 0,
      revenueFils: 0,
    },
  });

  uncosted = await makeStore('uncosted');
  await order(uncosted.storeId, uncosted.productId, { email: 'only@example.test' });

  // One guest buyer plus a registered customer of THIS store who never
  // ordered: a row on the Customers page, not a customer to analytics.
  zeroOrder = await makeStore('zero');
  await order(zeroOrder.storeId, zeroOrder.productId, { email: 'buyer@example.test' });
  const signup = await prisma.user.create({
    data: {
      storeId: zeroOrder.storeId,
      role: 'customer',
      email: `ak-signup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`,
      passwordHash: 'x',
      firstName: 'Z',
      lastName: 'O',
    },
  });
  users.push(signup.id);
});

afterAll(async () => {
  if (!hasDb) return;
  for (const storeId of stores) {
    await prisma.funnelSnapshot.deleteMany({ where: { storeId } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  }
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

describe.skipIf(!hasDb)('customer key: SQL twin agrees with the Customers page helper', () => {
  it('counts registered, email, phone and contact-less guests as the page does', async () => {
    const rows = await prisma.order.findMany({
      where: { storeId: mixed.storeId, deletedAt: null },
      select: { id: true, customerId: true, shippingAddress: true },
    });
    // The Customers list keys a contact-less guest order as its own row.
    const pageCount = new Set(rows.map(r => customerKeyOf(r) ?? `guest:${r.id}`)).size;
    // user · guest.a@ · phone · 2 contact-less · cancelled@
    expect(pageCount).toBe(6);
    expect(await AnalyticsService.countDistinctCustomers(mixed.storeId)).toBe(pageCount);
  });
});

describe.skipIf(!hasDb)('Customers page KPI summary agrees with analytics', () => {
  it('summary.customers equals allTimeCustomers on the same orders', async () => {
    const { summary, customers } = await withRlsBypass(() => aggregateCustomers(mixed.storeId));
    const stats = await dashboardStats(mixed.storeId);
    expect(customers.length).toBe(6);
    expect(summary.customers).toBe(stats.allTimeCustomers);
    // `buyers` drops the customer whose only order was cancelled; analytics
    // counts them, as the list does (docs/RULINGS.md).
    expect(summary.buyers).toBe(5);
  });

  it('a zero-order registered customer is a page row but not an analytics customer', async () => {
    const { summary } = await withRlsBypass(() => aggregateCustomers(zeroOrder.storeId));
    const stats = await dashboardStats(zeroOrder.storeId);
    expect(stats.allTimeCustomers).toBe(1);
    expect(summary.customers).toBe(2);
    expect(summary.buyers).toBe(1);
  });
});

describe.skipIf(!hasDb)('getDashboardStats (also the MCP admin_get_analytics payload)', () => {
  it('totalCustomers counts guests exactly like the Customers page', async () => {
    const stats = await dashboardStats(mixed.storeId);
    expect(stats.allTimeCustomers).toBe(6);
    expect(stats.totalCustomers).toBe(6);
  });

  it('profit covers costed lines and reports the lines without cost', async () => {
    const stats = await dashboardStats(mixed.storeId);
    // (1000−400)×2 + 5 × (1000−500)
    expect(stats.totalProfit).toBe(3700);
    // The second registered order's line and the 3000 guest line.
    expect(stats.profitItemsMissingCost).toBe(2);
    expect(stats.profitRevenueMissingCost).toBe(4000);
    // Incomplete profit is never compared to another period.
    expect(stats.profitChange).toBeNull();
  });

  it('profit is null (unknown), not 0, when no sold line has a cost', async () => {
    const stats = await dashboardStats(uncosted.storeId);
    expect(stats.totalProfit).toBeNull();
    expect(stats.profitItemsMissingCost).toBe(1);
    expect(stats.profitRevenueMissingCost).toBe(1000);
  });

  it('conversionRate is orders per product view, or null with no views', async () => {
    const withViews = await dashboardStats(mixed.storeId);
    expect(withViews.conversionRate).toBe(2.5);
    expect(withViews.conversionRateBasis).toBe('orders_per_product_view');
    const noViews = await dashboardStats(uncosted.storeId);
    expect(noViews.conversionRate).toBeNull();
  });
});
