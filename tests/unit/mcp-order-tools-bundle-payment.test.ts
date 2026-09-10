/**
 * `place_order`'s "online" branch (apps/api/src/mcp/tools/order.tools.ts)
 * used to build the payment-provider `items[]` from `order.items.map(...)`
 * directly — the same defect `payment-line-items.test.ts` documents for
 * `payment.routes.ts` /create, `order.routes.ts` payment-link, and
 * `payment.factory.ts` retry. An agent placing an online-payment order for a
 * bundle box sent the customer to a hosted payment page (Tap/MyFatoorah)
 * showing "Dates 3.724 / Honey 4.966 / Nuts x2 @ 1.655" instead of
 * "Ramadan Box 12.000" — this file is the fourth call site, missed by that
 * fix round because it lives under `mcp/`, not `routes/`.
 *
 * Mirrors `tests/unit/payment-line-items.test.ts`'s worked example so the
 * two suites can be compared line-for-line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('@force/database', () => ({
  prisma: { paymentConfig: { findFirst: vi.fn() } },
  runInTenantContext: vi.fn((_storeId: string, fn: () => unknown) => fn()),
  withTenantContext: vi.fn((_storeId: string, fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock('@api/services/order.service', () => ({
  OrderService: {
    create: vi.fn(),
    rollbackForPaymentFailure: vi.fn(),
  },
}));

vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: {
    getDefaultProvider: vi.fn(),
    createPayment: vi.fn(),
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

const store = { id: 'store-1', name: 'Demo Store', slug: 'demo', currency: 'KWD', domain: null };

const customer = { name: 'Sara Ali', address: 'Block 1, Street 2', country: 'KW' };

describe('order.tools place_order (online) — payment-provider line items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(PaymentService.getDefaultProvider).mockResolvedValue('tap' as never);
    vi.mocked(PaymentService.createPayment).mockResolvedValue({
      paymentUrl: 'https://pay.example/abc',
    } as never);
  });

  it('collapses a bundle order into ONE payment line at the bundle price — never the per-component allocated prices', async () => {
    vi.mocked(OrderService.create).mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      total: 12000,
      currency: 'KWD',
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

    expect(PaymentService.createPayment).toHaveBeenCalledTimes(1);
    const request = vi.mocked(PaymentService.createPayment).mock.calls[0][0] as {
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
      currency: 'KWD',
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

    const request = vi.mocked(PaymentService.createPayment).mock.calls[0][0] as {
      items: { name: string; quantity: number; unitPrice: number; sku?: string }[];
    };
    expect(request.items).toEqual([
      { name: 'Rug', quantity: 2, unitPrice: 3000, sku: 'RUG-1' },
      { name: 'Lamp', quantity: 1, unitPrice: 2000, sku: undefined },
    ]);
  });
});
