/**
 * `place_order`'s "online" branch (apps/api/src/mcp/tools/order.tools.ts)
 * used to build the payment-provider `items[]` from `order.items.map(...)`
 * directly — the same defect `payment-line-items.test.ts` documents for
 * `payment.routes.ts` /create, `order.routes.ts` payment-link, and
 * `payment.factory.ts` retry. An agent placing an online-payment order for a
 * bundle box sent the customer to a hosted payment page (Paymob/Kashier/Fawry)
 * showing "Dates 3.724 / Honey 4.966 / Nuts x2 @ 1.655" instead of
 * "Ramadan Box 12.000" — this file is the fourth call site, missed by that
 * fix round because it lives under `mcp/`, not `routes/`.
 *
 * Mirrors `tests/unit/payment-line-items.test.ts`'s worked example so the
 * two suites can be compared line-for-line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// place_order may call CartService.acknowledgePrices (Ruling B5-17); these suites are about payment bookkeeping.
vi.mock('@api/services/cart.service', () => ({ CartService: { acknowledgePrices: vi.fn() } }));
vi.mock('@ebda/database', () => ({
  prisma: { paymentConfig: { findFirst: vi.fn() } },
  runInTenantContext: vi.fn((_storeId: string, fn: () => unknown) => fn()),
  withTenantContext: vi.fn((_storeId: string, fn: (tx: unknown) => unknown) => fn({})),
}));

// order.tools opens its scopes through runInStoreTenantContext (a DO store gets a bare scope, a Postgres store the
// tenant transaction); this suite is a Postgres store, so it delegates to the mocked runInTenantContext it asserts on.
vi.mock('@api/lib/store-scoped-read', async () => {
  const db = await import('@ebda/database');
  return {
    runInStoreTenantContext: (storeId: string, fn: () => unknown) =>
      db.runInTenantContext(storeId, fn as never),
  };
});

vi.mock('@api/services/order.service', () => ({
  OrderService: {
    create: vi.fn(),
    rollbackForPaymentFailure: vi.fn(),
  },
}));

vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: {
    getDefaultProvider: vi.fn(),
    // SP6b: the provider call (request) and the record are SEPARATE, so no transaction is
    // held across the gateway; `createPayment` is not used by this tool any more.
    requestProviderPayment: vi.fn(),
    recordProviderPayment: vi.fn(),
  },
}));

vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@api/config', () => ({
  config: { webUrl: 'https://demo-store.example', apiUrl: 'https://api.demo-store.example' },
}));

import { registerOrderTools } from '@api/mcp/tools/order.tools';
import { authorizedAgentExtra } from '../helpers/mcp-agent-auth';
import { OrderService } from '@api/services/order.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { runInTenantContext } from '@ebda/database';

function harness() {
  // `place_order` is a WRITE tool: it now refuses without the `agent:write`
  // scope the MCP SDK forwards as `extra.authInfo`, so the harness passes the
  // second handler argument through and every call below supplies an
  // authorised `extra` (`authorizedAgentExtra()`). Dropping it makes these
  // tests red with AGENT_CREDENTIAL_REQUIRED, which is the point.
  const tools: Record<
    string,
    (input: unknown, extra?: unknown) => Promise<{ content: unknown[] }>
  > = {};
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (input: unknown, extra?: unknown) => Promise<unknown>
    ) => {
      tools[name] = handler as (input: unknown, extra?: unknown) => Promise<{ content: unknown[] }>;
    },
  } as unknown as McpServer;
  return { server, tools };
}

/** What `requestProviderPayment` resolves with: which provider answered, and its response. */
function accepted(extra: Record<string, unknown> = {}) {
  return {
    providerName: 'paymob',
    response: {
      provider: 'paymob',
      transactionId: 'txn-1',
      paymentUrl: 'https://pay.example/abc',
      ...extra,
    },
  } as never;
}

const store = { id: 'store-1', name: 'Demo Store', slug: 'demo', currency: 'EGP', domain: null };

const customer = { name: 'Sara Ali', address: 'Block 1, Street 2', country: 'EG' };

describe('order.tools place_order (online) — payment-provider line items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(PaymentService.getDefaultProvider).mockResolvedValue('paymob' as never);
    vi.mocked(PaymentService.requestProviderPayment).mockResolvedValue(accepted());
    vi.mocked(PaymentService.recordProviderPayment).mockResolvedValue(undefined);
  });

  it('collapses a bundle order into ONE payment line at the bundle price — never the per-component allocated prices', async () => {
    vi.mocked(OrderService.create).mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      total: 12000,
      currency: 'EGP',
      items: [
        {
          id: 'oi-1',
          productName: 'Dates',
          quantity: 1,
          price: 3724,
          sku: null,
          bundleGroupId: 'grp-1',
          bundleName: 'Ramadan Box',
          bundleNameAr: 'علبة رمضان',
        },
        {
          id: 'oi-2',
          productName: 'Honey',
          quantity: 1,
          price: 4966,
          sku: null,
          bundleGroupId: 'grp-1',
          bundleName: 'Ramadan Box',
          bundleNameAr: 'علبة رمضان',
        },
        {
          id: 'oi-3',
          productName: 'Nuts',
          quantity: 2,
          price: 1655,
          sku: null,
          bundleGroupId: 'grp-1',
          bundleName: 'Ramadan Box',
          bundleNameAr: 'علبة رمضان',
        },
      ],
    } as never);

    const { server, tools } = harness();
    registerOrderTools(server, store as never);

    await tools.place_order(
      { cartId: 'cart-1', paymentMethod: 'online', customer },
      authorizedAgentExtra()
    );

    expect(PaymentService.requestProviderPayment).toHaveBeenCalledTimes(1);
    const request = vi.mocked(PaymentService.requestProviderPayment).mock.calls[0][0] as {
      items: { name: string; quantity: number; unitPrice: number }[];
    };

    expect(request.items).toHaveLength(1);
    expect(request.items[0]).toMatchObject({
      name: 'Ramadan Box',
      quantity: 1,
      unitPrice: 12000,
    });

    // Totals must reconcile exactly to what the customer is charged.
    const builtTotal = request.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    expect(builtTotal).toBe(3724 + 4966 + 1655 * 2);

    // No per-component name or allocated price anywhere in the sent payload.
    const serialized = JSON.stringify(request.items);
    expect(serialized).not.toContain('Dates');
    expect(serialized).not.toContain('Honey');
    expect(serialized).not.toContain('Nuts');
    expect(serialized).not.toContain('3724');
  });

  it('leaves a non-bundle order unchanged — one payment line per product, same shape as before this fix', async () => {
    vi.mocked(OrderService.create).mockResolvedValue({
      id: 'order-2',
      orderNumber: 'ORD-2',
      total: 8000,
      currency: 'EGP',
      items: [
        { id: 'oi-4', productName: 'Rug', quantity: 2, price: 3000, sku: 'RUG-1' },
        { id: 'oi-5', productName: 'Lamp', quantity: 1, price: 2000, sku: null },
      ],
    } as never);

    const { server, tools } = harness();
    registerOrderTools(server, store as never);

    await tools.place_order(
      { cartId: 'cart-2', paymentMethod: 'online', customer },
      authorizedAgentExtra()
    );

    const request = vi.mocked(PaymentService.requestProviderPayment).mock.calls[0][0] as {
      items: { name: string; quantity: number; unitPrice: number; sku?: string }[];
    };
    expect(request.items).toEqual([
      { name: 'Rug', quantity: 2, unitPrice: 3000, sku: 'RUG-1' },
      { name: 'Lamp', quantity: 1, unitPrice: 2000, sku: undefined },
    ]);
  });
});

/**
 * #900 (S5-mcp-agent-write-security, 2026-09-25 security audit).
 *
 * The online branch's order-create + `PaymentService.createPayment` (+ its
 * compensating rollback) used to run OUTSIDE any tenant context — unlike the
 * COD branch (`withTenantContext`) and unlike the human path
 * (`payment.routes.ts:230`, `runInTenantContext(order.storeId, …)`). Latent
 * only because production connects as the BYPASSRLS role today; under RLS
 * enforcement every SELECT the provider call makes would silently fall
 * through to the "current_store_id() IS NULL → see all rows" branch instead
 * of being scoped.
 */
describe('order.tools place_order (online) — #900 tenant context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(PaymentService.getDefaultProvider).mockResolvedValue('paymob' as never);
    vi.mocked(PaymentService.recordProviderPayment).mockResolvedValue(undefined);
    vi.mocked(OrderService.create).mockResolvedValue({
      id: 'order-3',
      orderNumber: 'ORD-3',
      total: 5000,
      currency: 'EGP',
      items: [{ id: 'oi-1', productName: 'Rug', quantity: 1, price: 5000, sku: null }],
    } as never);
  });

  it('wraps order-create + the payment record in runInTenantContext(store.id, …)', async () => {
    vi.mocked(PaymentService.requestProviderPayment).mockResolvedValue(accepted());
    const { server, tools } = harness();
    registerOrderTools(server, store as never);

    await tools.place_order(
      { cartId: 'cart-3', paymentMethod: 'online', customer },
      authorizedAgentExtra()
    );

    expect(vi.mocked(runInTenantContext)).toHaveBeenCalledWith(store.id, expect.any(Function));
    expect(OrderService.create).toHaveBeenCalled();
  });

  it('runs OrderService.create and the payment RECORD each inside a tenant wrap, and the PROVIDER CALL inside none (issue 2059, SP6b)', async () => {
    let depth = 0;
    vi.mocked(runInTenantContext).mockImplementation((async (
      _storeId: string,
      fn: () => unknown
    ) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    }) as never);
    const insideAt: Record<string, number> = {};
    vi.mocked(OrderService.create).mockImplementation((async () => {
      insideAt.create = depth;
      return {
        id: 'order-3',
        orderNumber: 'ORD-3',
        total: 5000,
        currency: 'EGP',
        items: [{ id: 'oi-1', productName: 'Rug', quantity: 1, price: 5000, sku: null }],
      };
    }) as never);
    vi.mocked(PaymentService.requestProviderPayment).mockImplementation((async () => {
      insideAt.providerCall = depth;
      return accepted();
    }) as never);
    vi.mocked(PaymentService.recordProviderPayment).mockImplementation((async () => {
      insideAt.record = depth;
    }) as never);
    const { server, tools } = harness();
    registerOrderTools(server, store as never);

    await tools.place_order(
      { cartId: 'cart-3', paymentMethod: 'online', customer },
      authorizedAgentExtra()
    );

    // The order and the record are each inside exactly one wrap; the gateway call holds NONE
    // (no transaction and no pooled connection while a slow gateway answers).
    expect(insideAt).toEqual({ create: 1, providerCall: 0, record: 1 });
    vi.mocked(runInTenantContext).mockImplementation(((_s: string, fn: () => unknown) =>
      fn()) as never);
  });

  it('runs the compensating rollback for a failed provider call, in its own tenant context', async () => {
    vi.mocked(PaymentService.requestProviderPayment).mockRejectedValue(new Error('gateway down'));
    vi.mocked(OrderService.rollbackForPaymentFailure).mockResolvedValue(undefined as never);
    const { server, tools } = harness();
    registerOrderTools(server, store as never);

    await expect(
      tools.place_order(
        { cartId: 'cart-3', paymentMethod: 'online', customer },
        authorizedAgentExtra()
      )
    ).rejects.toThrow('gateway down');

    expect(vi.mocked(runInTenantContext)).toHaveBeenCalledWith(store.id, expect.any(Function));
    expect(OrderService.rollbackForPaymentFailure).toHaveBeenCalledWith(
      store.id,
      'order-3',
      'cart-3'
    );
  });

  // Issue 2058: the rollback used to live INSIDE the wrap's callback, so a
  // failure of the wrap's own COMMIT (or its 30s timeout) — which rejects
  // AFTER the callback returned — skipped it and stranded a pending order
  // with stock taken, cart cleared and no Payment row.
  it('still rolls the order back when the payment wrap fails AFTER the record resolved (commit failure)', async () => {
    vi.mocked(PaymentService.requestProviderPayment).mockResolvedValue(accepted());
    vi.mocked(OrderService.rollbackForPaymentFailure).mockResolvedValue(undefined as never);
    let call = 0;
    vi.mocked(runInTenantContext).mockImplementation((async (
      _storeId: string,
      fn: () => unknown
    ) => {
      call += 1;
      const out = await fn();
      // 1st wrap = order-create (commits), 2nd = the payment record (its COMMIT fails).
      if (call === 2) throw new Error('P2028 transaction commit failed');
      return out;
    }) as never);
    const { server, tools } = harness();
    registerOrderTools(server, store as never);

    await expect(
      tools.place_order(
        { cartId: 'cart-3', paymentMethod: 'online', customer },
        authorizedAgentExtra()
      )
    ).rejects.toThrow('P2028');

    expect(OrderService.rollbackForPaymentFailure).toHaveBeenCalledWith(
      store.id,
      'order-3',
      'cart-3'
    );
    vi.mocked(runInTenantContext).mockImplementation(((_s: string, fn: () => unknown) =>
      fn()) as never);
  });

  it('never rolls back an order whose payment wrap committed', async () => {
    vi.mocked(PaymentService.requestProviderPayment).mockResolvedValue(accepted());
    const { server, tools } = harness();
    registerOrderTools(server, store as never);

    await tools.place_order(
      { cartId: 'cart-3', paymentMethod: 'online', customer },
      authorizedAgentExtra()
    );

    expect(OrderService.rollbackForPaymentFailure).not.toHaveBeenCalled();
    // Two separate wraps: order-create, then the Payment write (the provider call holds none).
    expect(vi.mocked(runInTenantContext)).toHaveBeenCalledTimes(2);
  });
});
