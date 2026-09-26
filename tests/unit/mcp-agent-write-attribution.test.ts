/**
 * MCP agent-write ATTRIBUTION.
 *
 * Before this change the agent write surface was unmeasurable in every table
 * and every log:
 *   - `cart.tools.ts` and `catalog.tools.ts` wrote ZERO audit rows.
 *   - `place_order`'s single `payment.created` row omitted `userId`, `ip` and
 *     `userAgent` — all three real columns on `audit_logs` that `auditLog`
 *     persists; it simply was not being given them.
 *   - A REFUSED or FAILED agent checkout wrote nothing at all, so the signal
 *     you most want (someone is trying) did not exist.
 *
 * These tests assert the three rows that now exist and that each carries the
 * ip/user-agent the request arrived with.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { authorizedAgentExtra, anonymousAgentExtra } from '../helpers/mcp-agent-auth';

const mockAuditLog = vi.fn().mockResolvedValue(undefined);
const mockPaymentConfigFindFirst = vi.fn();

vi.mock('@force/database', () => ({
  prisma: { paymentConfig: { findFirst: (...a: unknown[]) => mockPaymentConfigFindFirst(...a) } },
  runInTenantContext: vi.fn((_s: string, fn: () => unknown) => fn()),
  withTenantContext: vi.fn((_s: string, fn: (tx: unknown) => unknown) =>
    fn({
      order: { update: vi.fn() },
      payment: { create: vi.fn().mockResolvedValue({ id: 'pay-1' }) },
    })
  ),
}));

vi.mock('@api/middleware/security', () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }));

vi.mock('@api/services/order.service', () => ({
  OrderService: { create: vi.fn(), rollbackForPaymentFailure: vi.fn() },
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { getDefaultProvider: vi.fn(), createPayment: vi.fn() },
}));
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/services/cart.service', () => ({
  CartService: { addItem: vi.fn(), getOrCreate: vi.fn(), view: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://store.force-ai.co', apiUrl: 'https://api.force-ai.co' },
}));

import { registerOrderTools } from '@api/mcp/tools/order.tools';
import { registerCartTools } from '@api/mcp/tools/cart.tools';
import { OrderService } from '@api/services/order.service';
import { CartService } from '@api/services/cart.service';

function harness(register: (s: McpServer, store: never) => void) {
  const tools: Record<string, (input: unknown, extra?: unknown) => Promise<unknown>> = {};
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      handler: (input: unknown, extra?: unknown) => Promise<unknown>
    ) => {
      tools[name] = handler;
    },
  } as unknown as McpServer;
  register(server, store as never);
  return tools;
}

const store = { id: 'store-1', name: 'Demo', slug: 'demo', currency: 'KWD', domain: null };
const customer = { name: 'Sara Ali', address: 'Block 1', country: 'KW' };

/** The single auditLog call whose `action` matches. */
function rowFor(action: string) {
  const call = mockAuditLog.mock.calls.find(
    c => (c[0] as { action: string }).action === action
  )?.[0];
  return call as
    | { action: string; ip?: string; userAgent?: string; details?: Record<string, unknown> }
    | undefined;
}

describe('place_order — attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentConfigFindFirst.mockResolvedValue({ fixedFee: null });
    vi.mocked(OrderService.create).mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      status: 'pending',
      total: 3000,
      currency: 'KWD',
      items: [],
    } as never);
  });

  it('writes an `agent.write.denied` row carrying ip + userAgent when the write is REFUSED', async () => {
    const tools = harness(registerOrderTools);

    await expect(
      tools.place_order(
        { cartId: 'cart-1', paymentMethod: 'cod', customer },
        anonymousAgentExtra({ ip: '198.51.100.9', userAgent: 'rogue-agent/2' })
      )
    ).rejects.toThrow();

    const row = rowFor('agent.write.denied');
    expect(row).toBeDefined();
    expect(row?.ip).toBe('198.51.100.9');
    expect(row?.userAgent).toBe('rogue-agent/2');
    expect(row?.details?.tool).toBe('place_order');
    expect(row?.details?.grant).toBe('denied');
    // and nothing was written to the money path
    expect(OrderService.create).not.toHaveBeenCalled();
  });

  it('writes an `agent.write.failed` row carrying ip + userAgent when an authorised write FAILS', async () => {
    mockPaymentConfigFindFirst.mockResolvedValue(null); // COD not available
    const tools = harness(registerOrderTools);

    await expect(
      tools.place_order(
        { cartId: 'cart-1', paymentMethod: 'cod', customer },
        authorizedAgentExtra({ ip: '198.51.100.4', userAgent: 'claude/1' })
      )
    ).rejects.toThrow();

    const row = rowFor('agent.write.failed');
    expect(row).toBeDefined();
    expect(row?.ip).toBe('198.51.100.4');
    expect(row?.userAgent).toBe('claude/1');
    expect(row?.details?.error).toMatch(/Cash on Delivery/);
  });

  it('adds ip + userAgent + the agent grant to the SUCCESS `payment.created` row', async () => {
    const tools = harness(registerOrderTools);

    await tools.place_order(
      { cartId: 'cart-1', paymentMethod: 'cod', customer },
      authorizedAgentExtra({ ip: '203.0.113.1', userAgent: 'claude/1' })
    );

    const row = rowFor('payment.created');
    expect(row).toBeDefined();
    expect(row?.ip).toBe('203.0.113.1');
    expect(row?.userAgent).toBe('claude/1');
    expect(row?.details?.source).toBe('agent');
    expect(row?.details?.credential).toBe('valid');
  });
});

describe('add_to_cart — attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CartService.addItem).mockResolvedValue({
      items: [],
      bundles: [],
      subtotal: 0,
    } as never);
  });

  it('refuses an anonymous call and records it with ip + userAgent, touching no cart', async () => {
    const tools = harness(registerCartTools);

    await expect(
      tools.add_to_cart(
        { productId: 'p-1', quantity: 1 },
        anonymousAgentExtra({ ip: '198.51.100.9', userAgent: 'rogue-agent/2' })
      )
    ).rejects.toThrow();

    expect(CartService.addItem).not.toHaveBeenCalled();
    const row = rowFor('agent.write.denied');
    expect(row?.ip).toBe('198.51.100.9');
    expect(row?.details?.tool).toBe('add_to_cart');
  });

  it('permits an authorised call and writes no denial row', async () => {
    const tools = harness(registerCartTools);

    await tools.add_to_cart({ productId: 'p-1', quantity: 1 }, authorizedAgentExtra());

    expect(CartService.addItem).toHaveBeenCalled();
    expect(rowFor('agent.write.denied')).toBeUndefined();
  });

  it('leaves view_cart ANONYMOUS — a read is never gated (FM-1 guard)', async () => {
    vi.mocked(CartService.view).mockResolvedValue({
      items: [],
      bundles: [],
      subtotal: 0,
    } as never);
    const tools = harness(registerCartTools);

    // No `extra` at all — exactly what an unauthenticated agent produces.
    await expect(tools.view_cart({ cartId: 'sess_x' })).resolves.toBeDefined();
    expect(CartService.view).toHaveBeenCalled();
  });
});
