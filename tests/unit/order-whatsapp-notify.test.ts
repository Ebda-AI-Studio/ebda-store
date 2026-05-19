/**
 * Order WhatsApp Notify — Inngest Function Unit Tests
 *
 * Tests handleOrderWhatsAppNotify (the extracted business logic) in isolation.
 * All external dependencies (prisma, wbsBridgeService, Sentry) are mocked.
 *
 * Key behaviours tested:
 *   - Skip when store has wbsEnabled=false
 *   - Skip when customer phone is missing or not E.164
 *   - Skip when template not configured for the event
 *   - Happy path for order/created (paid), order/shipped, order/delivered
 *   - WbsUnauthorizedError (401) → no retry + NotificationLog with UNAUTHORIZED + auto-disable
 *   - WbsTemplateMissingError (422) → no retry + NotificationLog with TEMPLATE_MISSING
 *   - WbsServerError (5xx) → rethrows (Inngest retries)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPrismaStore = {
  findUnique: vi.fn(),
  update: vi.fn(),
};

const mockPrismaOrder = {
  findUnique: vi.fn(),
};

const mockPrismaNotificationLog = {
  create: vi.fn().mockResolvedValue({}),
  count: vi.fn().mockResolvedValue(0),
};

vi.mock('@force/database', () => ({
  prisma: {
    store: mockPrismaStore,
    order: mockPrismaOrder,
    notificationLog: mockPrismaNotificationLog,
  },
}));

const mockSendOrderNotification = vi.fn();
vi.mock('@api/services/wbs-bridge.service', () => {
  class WbsUnauthorizedError extends Error {
    code = 'WBS_UNAUTHORIZED';
    constructor(msg?: string) {
      super(msg || 'WBS 401');
      this.name = 'WbsUnauthorizedError';
    }
  }
  class WbsTemplateMissingError extends Error {
    code = 'WBS_TEMPLATE_MISSING';
    constructor(msg?: string) {
      super(msg || 'WBS 422');
      this.name = 'WbsTemplateMissingError';
    }
  }
  class WbsServerError extends Error {
    code = 'WBS_SERVER_ERROR';
    constructor(msg?: string) {
      super(msg || 'WBS 503');
      this.name = 'WbsServerError';
    }
  }
  return {
    wbsBridgeService: { sendOrderNotification: mockSendOrderNotification },
    WbsUnauthorizedError,
    WbsTemplateMissingError,
    WbsServerError,
  };
});

vi.mock('@api/services/encryption.service', () => ({
  encryption: {
    decrypt: vi.fn().mockReturnValue('plain-api-key'),
  },
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
  },
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STORE_ID = 'store-uuid-1';
const ORDER_ID = 'order-uuid-1';
const CLIENT_ID = 'client-uuid-1';

const ACTIVE_STORE = {
  name: 'Test Store',
  wbsEnabled: true,
  wbsClientId: CLIENT_ID,
  wbsApiKey: 'encrypted-key',
  wbsTemplates: {
    orderPaid: { name: 'order_confirmation', languageCode: 'en' },
    orderShipped: { name: 'shipping_update', languageCode: 'en' },
    orderDelivered: { name: 'delivery_confirmation', languageCode: 'en' },
  },
};

const ORDER_WITH_PHONE = {
  orderNumber: 'ORD-001',
  total: 10500, // 10.500 KWD
  currency: 'KWD',
  shippingAddress: { firstName: 'Ahmed', lastName: 'Sharaf', phone: '+96512345678' },
  shipment: null,
  customer: null,
};

// ─── Test helper ─────────────────────────────────────────────────────────────

/**
 * step stub that executes step.run callbacks immediately (synchronous simulation).
 * This mirrors how Inngest behaves in a single execution with no checkpointing.
 */
const stepStub = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
  sleep: vi.fn().mockResolvedValue(undefined),
};

async function runHandler(eventName: string, orderId: string, storeId: string) {
  const { handleOrderWhatsAppNotify } =
    await import('@api/lib/inngest/functions/order-whatsapp-notify');
  return handleOrderWhatsAppNotify(
    eventName as 'order/created' | 'order/shipped' | 'order/delivered',
    orderId,
    storeId,
    stepStub
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('orderWhatsAppNotify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaStore.findUnique.mockResolvedValue(ACTIVE_STORE);
    mockPrismaOrder.findUnique.mockResolvedValue(ORDER_WITH_PHONE);
    mockPrismaNotificationLog.create.mockResolvedValue({});
    mockPrismaNotificationLog.count.mockResolvedValue(0);
    mockPrismaStore.update.mockResolvedValue({});
    mockSendOrderNotification.mockResolvedValue({ messageId: 'wamid.test', status: 'sent' });
  });

  it('skips when store is not found', async () => {
    mockPrismaStore.findUnique.mockResolvedValue(null);
    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: expect.stringContaining('store') });
    expect(mockSendOrderNotification).not.toHaveBeenCalled();
  });

  it('skips when wbsEnabled is false', async () => {
    mockPrismaStore.findUnique.mockResolvedValue({ ...ACTIVE_STORE, wbsEnabled: false });
    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: 'wbs-disabled' });
    expect(mockSendOrderNotification).not.toHaveBeenCalled();
  });

  it('skips when wbsClientId is missing', async () => {
    mockPrismaStore.findUnique.mockResolvedValue({
      ...ACTIVE_STORE,
      wbsClientId: null,
      wbsApiKey: null,
    });
    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: 'wbs-not-configured' });
  });

  it('skips when template name is not configured for the event', async () => {
    mockPrismaStore.findUnique.mockResolvedValue({
      ...ACTIVE_STORE,
      wbsTemplates: { orderPaid: { name: '', languageCode: 'en' } },
    });
    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: 'template-not-configured' });
  });

  it('skips when customer phone is missing', async () => {
    mockPrismaOrder.findUnique.mockResolvedValue({
      ...ORDER_WITH_PHONE,
      customer: null,
      shippingAddress: { firstName: 'Ahmed' },
    });
    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: 'invalid-phone' });
    expect(mockSendOrderNotification).not.toHaveBeenCalled();
  });

  it('skips when phone is not E.164', async () => {
    mockPrismaOrder.findUnique.mockResolvedValue({
      ...ORDER_WITH_PHONE,
      shippingAddress: { phone: '05512345678' }, // missing +
    });
    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: 'invalid-phone' });
  });

  it('happy path: order/created sends orderPaid template', async () => {
    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(mockSendOrderNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'order_confirmation',
        languageCode: 'en',
        recipientPhone: '+96512345678',
        variables: expect.arrayContaining(['ORD-001']),
        idempotencyKey: expect.stringContaining(ORDER_ID),
      })
    );
    expect(result).toMatchObject({ sent: true });
  });

  it('happy path: order/shipped sends orderShipped template', async () => {
    await runHandler('order/shipped', ORDER_ID, STORE_ID);
    expect(mockSendOrderNotification).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'shipping_update' })
    );
  });

  it('happy path: order/delivered sends orderDelivered template', async () => {
    await runHandler('order/delivered', ORDER_ID, STORE_ID);
    expect(mockSendOrderNotification).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'delivery_confirmation' })
    );
  });

  it('on WbsUnauthorizedError: does not rethrow, logs failure, does not disable store when below threshold', async () => {
    const { WbsUnauthorizedError } = await import('@api/services/wbs-bridge.service');
    mockSendOrderNotification.mockRejectedValue(new WbsUnauthorizedError());
    mockPrismaNotificationLog.count.mockResolvedValue(0); // below threshold

    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: 'wbs-unauthorized' });
    expect(mockPrismaStore.update).not.toHaveBeenCalled(); // no auto-disable yet
    expect(mockPrismaNotificationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', error: 'WBS_UNAUTHORIZED' }),
      })
    );
  });

  it('on WbsUnauthorizedError with 2 prior failures: auto-disables store', async () => {
    const { WbsUnauthorizedError } = await import('@api/services/wbs-bridge.service');
    mockSendOrderNotification.mockRejectedValue(new WbsUnauthorizedError());
    mockPrismaNotificationLog.count.mockResolvedValue(2); // at threshold - 1

    await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(mockPrismaStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STORE_ID },
        data: { wbsEnabled: false },
      })
    );
  });

  it('on WbsTemplateMissingError: does not rethrow, logs failure', async () => {
    const { WbsTemplateMissingError } = await import('@api/services/wbs-bridge.service');
    mockSendOrderNotification.mockRejectedValue(new WbsTemplateMissingError());

    const result = await runHandler('order/created', ORDER_ID, STORE_ID);
    expect(result).toMatchObject({ skipped: 'template-not-approved' });
    expect(mockPrismaNotificationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', error: 'WBS_TEMPLATE_MISSING' }),
      })
    );
  });

  it('on WbsServerError: rethrows so Inngest can retry', async () => {
    const { WbsServerError } = await import('@api/services/wbs-bridge.service');
    mockSendOrderNotification.mockRejectedValue(new WbsServerError());

    await expect(runHandler('order/created', ORDER_ID, STORE_ID)).rejects.toThrow('WBS 503');
  });
});
