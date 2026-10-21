/**
 * Issue 2444 — when ONLY the guest side of an order search is over `ORDER_SEARCH_CUSTOMER_ID_CAP`
 * (every Egypt guest phone starts `+965`, so the digits of a phone typed left to right match every
 * guest order), `orderSearchWhere` returned the whole four-LEFT-JOIN `relationFallback`, discarding
 * the registered-customer lookup that had already succeeded. Each half now degrades on its own.
 *
 * Mutation-proof: restoring `if (guestOrderIds.length > CAP) return relationFallback` reddens the
 * first case (the `customerId IN` arm is gone, the relation arm is back).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  customers: vi.fn(),
  guests: vi.fn(),
  numbers: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  prisma: {
    // two store-scoped definers: ebda_customer_search_ids(...) -> (kind, id) rows for customers +
    // guest orders, and ebda_order_search_ids(store, kind, pattern, limit) for the order number
    $queryRaw: async (sql: { strings: string[]; values: unknown[] }) => {
      if (sql.strings.join('').includes('ebda_customer_search_ids')) {
        h.queryRaw('customers+guests');
        const users = (await h.customers()) as Array<{ id: string }>;
        const guests = (await h.guests()) as Array<{ id: string }>;
        return [
          ...users.map(r => ({ kind: 'user', id: r.id })),
          ...guests.map(r => ({ kind: 'guest_order', id: r.id })),
        ];
      }
      h.queryRaw(sql.values[1]);
      return h.numbers();
    },
  },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const { orderSearchWhere, ORDER_SEARCH_CUSTOMER_ID_CAP } =
  await import('@api/services/order.service');

const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const arms = async () => JSON.stringify(await orderSearchWhere('store-1', '+9655'));

beforeEach(() => {
  vi.clearAllMocks();
  h.numbers.mockResolvedValue([]);
});

describe('orderSearchWhere: each over-cap half degrades on its own (issue 2444)', () => {
  it('guest over the cap, customers under: customer_id IN arm survives, guest uses the JSON filter, no relation join', async () => {
    h.customers.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    h.guests.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'g').map(id => ({ id })));
    const out = await arms();
    expect(out).toContain('"customerId":{"in":["u1","u2"]}');
    expect(out).toContain('string_contains');
    expect(out).not.toContain('"customer":');
    expect(out).not.toContain('"id":{"in"');
  });

  it('customers over the cap, guests under: relation arm for customers, guest id IN arm survives', async () => {
    h.customers.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'u').map(id => ({ id })));
    h.guests.mockResolvedValue([{ id: 'g1' }]);
    const out = await arms();
    expect(out).toContain('"customer":');
    expect(out).toContain('"id":{"in":["g1"]}');
    expect(out).not.toContain('string_contains');
    expect(out).not.toContain('"customerId":{"in"');
  });

  it('both over the cap: the full relation fallback (customer relation + JSON filter)', async () => {
    h.customers.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'u').map(id => ({ id })));
    h.guests.mockResolvedValue(ids(ORDER_SEARCH_CUSTOMER_ID_CAP + 1, 'g').map(id => ({ id })));
    const out = await arms();
    expect(out).toContain('"customer":');
    expect(out).toContain('string_contains');
  });

  it('both under the cap: only indexed arms (order number, customer_id IN, id IN)', async () => {
    h.customers.mockResolvedValue([{ id: 'u1' }]);
    h.guests.mockResolvedValue([{ id: 'g1' }]);
    const out = await arms();
    expect(out).toContain('"customerId":{"in":["u1"]}');
    expect(out).toContain('"id":{"in":["g1"]}');
    expect(out).not.toContain('string_contains');
    expect(out).not.toContain('"customer":');
  });

  it('nothing matches: one explicit match-nothing arm', async () => {
    h.customers.mockResolvedValue([]);
    h.guests.mockResolvedValue([]);
    const w = await orderSearchWhere('store-1', '+9655');
    expect(JSON.stringify(w)).toBe('[{"id":{"in":[]}}]');
  });

  it('a customer searching their own orders (indexed: false) never calls the store-wide lookup', async () => {
    const w = await orderSearchWhere('store-1', '+9655', { indexed: false });
    expect(h.queryRaw).not.toHaveBeenCalled();
    const out = JSON.stringify(w);
    expect(out).toContain('string_contains'); // the relation / JSON fallback, ANDed with their customerId
    expect(out).not.toContain('"id":{"in"');
  });
});
