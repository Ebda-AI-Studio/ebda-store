/**
 * Issue 2444 — when ONLY the guest side of an order search is over `ORDER_SEARCH_CUSTOMER_ID_CAP`
 * (every Kuwait guest phone starts `+965`, so the digits of a phone typed left to right match every
 * guest order), `orderSearchWhere` returned the whole four-LEFT-JOIN `relationFallback`, discarding
 * the registered-customer lookup that had already succeeded. Each half now degrades on its own.
 *
 * Mutation-proof: restoring `if (guestOrderIds.length > CAP) return relationFallback` reddens the
 * first case (the `customerId IN` arm is gone, the relation arm is back).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ findMany: vi.fn(), queryRaw: vi.fn() }));

vi.mock('@force/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@force/database')>()),
  prisma: { user: { findMany: h.findMany }, $queryRaw: h.queryRaw },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const { orderSearchWhere, ORDER_SEARCH_CUSTOMER_ID_CAP } =
  await import('@api/services/order.service');

const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const arms = async () => JSON.stringify(await orderSearchWhere('store-1', '+9655'));

beforeEach(() => vi.clearAllMocks());

describe('orderSearchWhere: each over-cap half degrades on its own (issue 2444)', () => {
  it('guest over the cap, customers under: customer_id IN arm survives, guest uses the JSON filter, no relation join', async () => {
    h.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    h.queryRaw.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'g').map(id => ({ id })));
    const out = await arms();
    expect(out).toContain('"customerId":{"in":["u1","u2"]}');
    expect(out).toContain('string_contains');
    expect(out).not.toContain('"customer":');
    expect(out).not.toContain('"id":{"in"');
  });

  it('customers over the cap, guests under: relation arm for customers, guest id IN arm survives', async () => {
    h.findMany.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'u').map(id => ({ id })));
    h.queryRaw.mockResolvedValue([{ id: 'g1' }]);
    const out = await arms();
    expect(out).toContain('"customer":');
    expect(out).toContain('"id":{"in":["g1"]}');
    expect(out).not.toContain('string_contains');
    expect(out).not.toContain('"customerId":{"in"');
  });

  it('both over the cap: the full relation fallback (customer relation + JSON filter)', async () => {
    h.findMany.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'u').map(id => ({ id })));
    h.queryRaw.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'g').map(id => ({ id })));
    const out = await arms();
    expect(out).toContain('"customer":');
    expect(out).toContain('string_contains');
  });

  it('both under the cap: only indexed arms (order number, customer_id IN, id IN)', async () => {
    h.findMany.mockResolvedValue([{ id: 'u1' }]);
    h.queryRaw.mockResolvedValue([{ id: 'g1' }]);
    const out = await arms();
    expect(out).toContain('"customerId":{"in":["u1"]}');
    expect(out).toContain('"id":{"in":["g1"]}');
    expect(out).not.toContain('string_contains');
    expect(out).not.toContain('"customer":');
  });

  it('nothing matches: just the order-number arm', async () => {
    h.findMany.mockResolvedValue([]);
    h.queryRaw.mockResolvedValue([]);
    const w = await orderSearchWhere('store-1', '+9655');
    expect(w).toHaveLength(1);
  });
});
