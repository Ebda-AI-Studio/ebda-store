// Ruling B5-13: GOLD_PRICE_MANAGED (raised by the database guard) is a 409 with a business message,
// never an opaque 500, and nothing about the SQL leaks.
import { describe, it, expect } from 'vitest';
import { isGoldPriceManaged } from '../../apps/api/src/lib/prisma-errors';
import { clientErrorStatus, errorHandler } from '../../apps/api/src/middleware/error-handler';

const engineErr = new Error(
  'Invalid prisma.product.update() invocation: P0001 GOLD_PRICE_MANAGED: the price of a gold-rate product is written only by the repricer'
);
const adapterErr = Object.assign(new Error('Raw query failed'), {
  code: 'P2010',
  meta: {
    driverAdapterError: {
      cause: {
        originalMessage:
          'GOLD_PRICE_MANAGED: the price of a gold-rate variant is written only by the repricer',
      },
    },
  },
});

function respond(err: unknown) {
  const out: { status?: number; body?: Record<string, any> } = {};
  const res = {
    headersSent: false,
    status(n: number) {
      out.status = n;
      return this;
    },
    json(b: Record<string, any>) {
      out.body = b;
      return this;
    },
    end() {},
  };
  errorHandler(
    err as Error,
    { id: 'r1', headers: {}, method: 'PUT', originalUrl: '/x' } as never,
    res as never,
    () => {}
  );
  return out;
}

describe('GOLD_PRICE_MANAGED', () => {
  it('is recognised in the engine message and in the driver-adapter cause', () => {
    expect(isGoldPriceManaged(engineErr)).toBe(true);
    expect(isGoldPriceManaged(adapterErr)).toBe(true);
    expect(isGoldPriceManaged(new Error('something else'))).toBe(false);
    expect(isGoldPriceManaged(null)).toBe(false);
    expect(isGoldPriceManaged('GOLD_PRICE_MANAGED')).toBe(false);
  });
  it('classifies as a 409 client error', () => {
    expect(clientErrorStatus(engineErr)).toBe(409);
    expect(clientErrorStatus(adapterErr)).toBe(409);
  });
  it('answers 409 with a bilingual business message and no SQL text', () => {
    for (const err of [engineErr, adapterErr]) {
      const r = respond(err);
      expect(r.status).toBe(409);
      expect(r.body?.error.code).toBe('GOLD_PRICE_MANAGED');
      expect(r.body?.error.messageAr).toMatch(/سعر الدهب/);
      expect(JSON.stringify(r.body)).not.toMatch(/P0001|prisma|repricer|originalMessage/i);
    }
  });
});
