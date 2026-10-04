/**
 * issue 2360 (agent path) — `place_order` (online) asks the gateway, then records the
 * payment in a short wrap (SP6b: the gateway call itself holds no transaction). If that
 * wrap's COMMIT fails after the provider ACCEPTED, the order is rolled back but the invoice stays live at the
 * gateway with no Payment row behind it. The catch must name it in a P1
 * (`alertOrphanedProviderInvoice`) so an operator can void it.
 *
 * `runInTenantContext` is stubbed so the SECOND wrap (the payment one) runs
 * its callback and then throws — exactly a COMMIT failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const h = vi.hoisted(() => ({ wrapCalls: 0, failPaymentCommit: false, orphanAlert: vi.fn() }));

vi.mock('@force/database', () => ({
  prisma: { paymentConfig: { findFirst: vi.fn() } },
  runInTenantContext: vi.fn(async (_storeId: string, fn: () => unknown) => {
    h.wrapCalls++;
    const out = await fn();
    // wrap 1 = order create, wrap 2 = payment; later wraps = rollback.
    if (h.failPaymentCommit && h.wrapCalls === 2) throw new Error('COMMIT failed (P2028)');
    return out;
  }),
  withTenantContext: vi.fn((_storeId: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: { create: vi.fn(), rollbackForPaymentFailure: vi.fn() },
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: {
    getDefaultProvider: vi.fn(),
    requestProviderPayment: vi.fn(),
    recordProviderPayment: vi.fn(),
  },
}));
vi.mock('@api/services/payment-providers/orphaned-invoice-alert', () => ({
  alertOrphanedProviderInvoice: (...a: unknown[]) => h.orphanAlert(...a),
}));
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
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
  const tools: Record<string, (input: unknown, extra?: unknown) => Promise<unknown>> = {};
  const server = {
    registerTool: (
      name: string,
      _c: unknown,
      handler: (input: unknown, extra?: unknown) => Promise<unknown>
    ) => {
      tools[name] = handler;
    },
  } as unknown as McpServer;
  return { server, tools };
}

const store = { id: 'store-1', name: 'Demo Store', slug: 'demo', currency: 'EGP', domain: null };
const customer = { name: 'Sara Ali', address: 'Block 1, Street 2', country: 'EG' };

async function placeOnline() {
  const { server, tools } = harness();
  registerOrderTools(server, store as never);
  return tools.place_order(
    { cartId: 'cart-1', paymentMethod: 'online', customer },
    authorizedAgentExtra()
  );
}

describe('MCP place_order (online) — orphaned gateway invoice (issue 2360)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.wrapCalls = 0;
    h.failPaymentCommit = false;
    vi.mocked(PaymentService.getDefaultProvider).mockResolvedValue('paymob' as never);
    vi.mocked(PaymentService.requestProviderPayment).mockResolvedValue({
      providerName: 'paymob',
      response: {
        transactionId: 'chg_1',
        paymentUrl: 'https://pay.example/abc',
        provider: 'paymob',
      },
    } as never);
    vi.mocked(PaymentService.recordProviderPayment).mockResolvedValue(undefined);
    vi.mocked(OrderService.create).mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      total: 12000,
      currency: 'EGP',
      items: [],
    } as never);
  });

  it('provider accepted, payment COMMIT fails → rolled back AND the live invoice is alerted', async () => {
    h.failPaymentCommit = true;
    await expect(placeOnline()).rejects.toThrow(/COMMIT failed/);
    expect(OrderService.rollbackForPaymentFailure).toHaveBeenCalledWith(
      'store-1',
      'order-1',
      'cart-1'
    );
    expect(h.orphanAlert).toHaveBeenCalledTimes(1);
    expect(h.orphanAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: 'store-1',
        orderId: 'order-1',
        provider: 'paymob',
        transactionId: 'chg_1',
        source: 'agent',
      })
    );
  });

  it('provider rejected → rolled back, no orphaned-invoice alert', async () => {
    vi.mocked(PaymentService.requestProviderPayment).mockRejectedValueOnce(
      new Error('gateway 400')
    );
    await expect(placeOnline()).rejects.toThrow(/gateway 400/);
    expect(OrderService.rollbackForPaymentFailure).toHaveBeenCalled();
    expect(h.orphanAlert).not.toHaveBeenCalled();
  });

  it('committed payment → no rollback, no alert (control)', async () => {
    await placeOnline();
    expect(OrderService.rollbackForPaymentFailure).not.toHaveBeenCalled();
    expect(h.orphanAlert).not.toHaveBeenCalled();
  });
});
