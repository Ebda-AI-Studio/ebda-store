/**
 * Ruling SUSPEND-OUT-1 / 1b on the customer invoice job: a suspended store's invoice for an UNPAID order is not sent;
 * the invoice of a PAID order (a receipt) and the owner copy still are.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  operational: { value: false },
  paymentStatus: { value: 'completed' },
  sendInvoice: vi.fn(),
  captured: { handler: null as null | ((a: unknown) => Promise<unknown>) },
}));

vi.mock('@api/lib/store-operational', async orig => ({
  ...(await orig<typeof import('@api/lib/store-operational')>()),
  storeOperational: async () => h.operational.value,
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    order: {
      findUnique: async () => ({
        orderNumber: 'O-1',
        locale: 'en',
        paymentStatus: h.paymentStatus.value,
      }),
    },
  }),
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  runInStoreCtx: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/invoice.service', () => ({
  InvoiceService: { generateInvoiceEmail: async () => '<p/>' },
}));
vi.mock('@api/services/email.service', () => ({ EmailService: { sendInvoice: h.sendInvoice } }));
vi.mock('@api/lib/definer', () => ({ lookupStore: vi.fn() }));
vi.mock('@ebda/database', () => ({ storeDirectory: vi.fn() }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_c: unknown, handler: (a: unknown) => Promise<unknown>) => {
      h.captured.handler = handler;
      return {};
    },
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import '@api/lib/inngest/functions/invoice-email';

const step = { run: async (_id: string, fn: () => unknown) => fn() };
const run = (data: Record<string, unknown>) =>
  h.captured.handler!({ event: { name: 'order/invoice.email-requested', data }, step });
const base = { orderId: 'o1', storeId: 's1', to: 'c@x.test' };

beforeEach(() => {
  vi.clearAllMocks();
  h.operational.value = false;
  h.paymentStatus.value = 'completed';
});

describe('invoice email for a suspended store', () => {
  it('an UNPAID order (COD pending) invoice to the customer is not sent', async () => {
    h.paymentStatus.value = 'cod_pending';
    await run(base);
    expect(h.sendInvoice).not.toHaveBeenCalled();
  });

  it('a PAID order invoice is a receipt and still sends', async () => {
    await run(base);
    expect(h.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it('the owner copy (toMerchant) still sends for an unpaid order', async () => {
    h.paymentStatus.value = 'cod_pending';
    await run({ ...base, toMerchant: true });
    expect(h.sendInvoice).toHaveBeenCalledTimes(1);
  });

  it('an active store sends an unpaid-order invoice (unchanged)', async () => {
    h.operational.value = true;
    h.paymentStatus.value = 'cod_pending';
    await run(base);
    expect(h.sendInvoice).toHaveBeenCalledTimes(1);
  });
});
