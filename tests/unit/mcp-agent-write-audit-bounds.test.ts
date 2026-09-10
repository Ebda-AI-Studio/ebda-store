/**
 * MCP denied-write audit — INPUT BOUNDS.
 *
 * The denied-write audit row is written BEFORE the credential is checked, and
 * it persists caller-controlled input (`add_to_cart`'s `productId`,
 * `place_order`'s `cartId`) into `audit_logs.details`. With no length cap that
 * is a write amplifier pointed at the primary Neon database: the Express body
 * limit is 10mb, `publicLimiter` allows 300 requests/min/IP, and audit rows are
 * retained 90 days hot then archived for 7 years — so one anonymous IP could
 * push on the order of GB/min into permanent storage without ever holding a
 * credential.
 *
 * Two independent bounds, tested independently because either one alone would
 * be a single point of failure:
 *   1. The tool input schemas cap every id at `MCP_ID_MAX_CHARS`, so the bulk
 *      never reaches the handler at all.
 *   2. `auditAgentWrite` truncates every persisted `details` value, so the
 *      property holds even if a schema loses its `.max()` or an error message
 *      carries an unbounded payload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { anonymousAgentExtra } from '../helpers/mcp-agent-auth';

const mockAuditLog = vi.fn().mockResolvedValue(undefined);

vi.mock('@force/database', () => ({
  prisma: { paymentConfig: { findFirst: vi.fn() } },
  runInTenantContext: vi.fn((_s: string, fn: () => unknown) => fn()),
  withTenantContext: vi.fn((_s: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }));
vi.mock('@api/services/order.service', () => ({
  OrderService: { create: vi.fn(), rollbackForPaymentFailure: vi.fn() },
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { getDefaultProvider: vi.fn(), createPayment: vi.fn() },
}));
vi.mock('@api/services/payment-event.service', () => ({ recordPaymentEvent: vi.fn() }));
vi.mock('@api/services/cart.service', () => ({
  CartService: { addItem: vi.fn(), getOrCreate: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://store.force-ai.co', apiUrl: 'https://api.force-ai.co' },
}));

import { registerCartTools } from '@api/mcp/tools/cart.tools';
import { registerOrderTools } from '@api/mcp/tools/order.tools';
import { CartService } from '@api/services/cart.service';
import { AUDIT_DETAIL_MAX_CHARS, MCP_ID_MAX_CHARS } from '@api/mcp/agent-auth';

const store = { id: 'store-1', name: 'Demo', slug: 'demo', currency: 'KWD', domain: null };

type Handler = (input: unknown, extra?: unknown) => Promise<unknown>;
type Registered = { schema: Record<string, z.ZodTypeAny>; handler: Handler };

/** Captures the registered input SCHEMA as well as the handler. */
function harness(register: (s: McpServer, store: never) => void): Record<string, Registered> {
  const registered: Record<string, Registered> = {};
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema?: Record<string, z.ZodTypeAny> },
      handler: Handler
    ) => {
      registered[name] = { schema: config.inputSchema ?? {}, handler };
    },
  } as unknown as McpServer;
  register(server, store as never);
  return registered;
}

/** What an attacker sends: ~1MB of caller-controlled string. */
const HUGE = 'A'.repeat(1_000_000);

function deniedRow() {
  return mockAuditLog.mock.calls.find(c =>
    (c[0] as { action: string }).action.endsWith('denied')
  )?.[0] as { details?: Record<string, unknown> } | undefined;
}

describe('MCP write tools — id length is bounded at the schema', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an over-long productId/cartId/variantId on add_to_cart', () => {
    const { add_to_cart } = harness(registerCartTools);
    const schema = z.object(add_to_cart.schema);

    expect(schema.safeParse({ productId: HUGE, quantity: 1 }).success).toBe(false);
    expect(schema.safeParse({ productId: 'p-1', cartId: HUGE, quantity: 1 }).success).toBe(false);
    expect(schema.safeParse({ productId: 'p-1', variantId: HUGE, quantity: 1 }).success).toBe(
      false
    );
    // A real id is unaffected.
    expect(schema.safeParse({ productId: 'clx0000000000000000000000', quantity: 1 }).success).toBe(
      true
    );
    expect(schema.safeParse({ productId: 'p'.repeat(MCP_ID_MAX_CHARS), quantity: 1 }).success).toBe(
      true
    );
  });

  it('rejects an over-long cartId on place_order and view_cart', () => {
    const { place_order } = harness(registerOrderTools);
    const { view_cart } = harness(registerCartTools);
    const customer = { name: 'Sara Ali', address: 'Block 1', country: 'KW' };

    expect(
      z.object(place_order.schema).safeParse({ cartId: HUGE, paymentMethod: 'cod', customer })
        .success
    ).toBe(false);
    // view_cart is anonymous, and `getOrCreate` mints a Cart row keyed on this
    // exact string — the same amplification on a different table.
    expect(z.object(view_cart.schema).safeParse({ cartId: HUGE }).success).toBe(false);
    expect(z.object(view_cart.schema).safeParse({ cartId: 'sess_abc123' }).success).toBe(true);
  });
});

describe('auditAgentWrite — persisted details are truncated', () => {
  beforeEach(() => vi.clearAllMocks());

  it('truncates a huge productId on the pre-auth denied row for add_to_cart', async () => {
    const { add_to_cart } = harness(registerCartTools);

    // Handler called directly = schema bypassed, which is exactly the second
    // line of defence this asserts.
    await expect(
      add_to_cart.handler({ productId: HUGE, quantity: 1 }, anonymousAgentExtra())
    ).rejects.toThrow();

    const details = deniedRow()?.details;
    expect(details).toBeDefined();
    const recorded = details?.productId as string;
    expect(typeof recorded).toBe('string');
    expect(recorded.length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX_CHARS + '…[truncated]'.length);
    expect(recorded.startsWith('AAAA')).toBe(true); // still identifies the attempt
    expect(CartService.addItem).not.toHaveBeenCalled();
  });

  it('truncates a huge cartId on the pre-auth denied row for place_order', async () => {
    const { place_order } = harness(registerOrderTools);
    const customer = { name: 'Sara Ali', address: 'Block 1', country: 'KW' };

    await expect(
      place_order.handler({ cartId: HUGE, paymentMethod: 'cod', customer }, anonymousAgentExtra())
    ).rejects.toThrow();

    const details = deniedRow()?.details;
    expect((details?.cartId as string).length).toBeLessThanOrEqual(
      AUDIT_DETAIL_MAX_CHARS + '…[truncated]'.length
    );
    // Bounded values do not cost the row its attribution.
    expect(details?.tool).toBe('place_order');
    expect(details?.grant).toBe('denied');
    expect(details?.paymentMethod).toBe('cod');
  });

  it('leaves short values byte-for-byte intact', async () => {
    const { add_to_cart } = harness(registerCartTools);

    await expect(
      add_to_cart.handler({ productId: 'prod-42', quantity: 1 }, anonymousAgentExtra())
    ).rejects.toThrow();

    expect(deniedRow()?.details?.productId).toBe('prod-42');
  });
});
