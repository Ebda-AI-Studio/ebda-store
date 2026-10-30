/**
 * Ruling CF-JOBS-4B: the three ETA e-receipt jobs on a store's Durable Object. Postgres THROWS if reached; the receipt rows are an
 * in-memory stand-in for the DO tables, so the double fire is observable: the same order event delivered twice makes one row and
 * one submit event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  receipts: [] as Array<Record<string, any>>,
  sent: [] as Array<{ name: string; data: any }>,
  enabled: true,
  seq: 0,
}));
const match = (row: Record<string, any>, where: Record<string, any>) =>
  Object.entries(where).every(([k, v]) => row[k] === v);

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: prisma.${String(p)}`);
        },
      }
    ),
    extra: {
      withStore: async () => {
        throw new Error('Postgres touched: withStore');
      },
    },
  })
);
vi.mock('@api/lib/repo-factory', () => {
  const reads = {
    // the enqueue reads a `select`ed connection; the credentials loader reads the whole row (none stored here)
    etaConnection: {
      findFirst: async (a: { select?: unknown }) =>
        a.select ? { enabled: true, environment: 'preprod' } : null,
    },
    order: { findFirst: async () => ({ sellerTaxRegistrationNumber: '123456789' }) },
    etaReceipt: {
      findFirst: async (a: { where: Record<string, any> }) =>
        h.receipts.find(r => match(r, a.where)) ?? null,
    },
  };
  const writes = {
    etaReceipt: {
      create: async (a: { data: Record<string, any> }) => {
        if (
          h.receipts.some(r =>
            match(r, { orderId: a.data.orderId, kind: a.data.kind, seq: a.data.seq })
          )
        )
          throw new Error('unique');
        const row = { id: `rc${++h.seq}`, attempts: 0, ...a.data };
        h.receipts.push(row);
        return row;
      },
      updateMany: async (a: { where: Record<string, any>; data: Record<string, any> }) => {
        const rows = h.receipts.filter(r => match(r, a.where));
        rows.forEach(r => Object.assign(r, a.data));
        return { count: rows.length };
      },
    },
  };
  return {
    storeRepo: async () => ({ backend: 'do', db: reads, writer: writes }),
    storeDb: async () => reads,
    storeWriter: async () => writes,
    runInJobRepoScope: <T>(fn: () => T) => fn(),
  };
});
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async (e: { name: string; data: any }) => void h.sent.push(e)),
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => h.enabled },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  etaReceiptEnqueue,
  etaReceiptRedrive,
  etaReceiptSubmit,
} from '@api/lib/inngest/functions/eta-receipt';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

type Handler = { handler: (a: unknown) => Promise<unknown> };
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
  sleep: async () => undefined,
  sleepUntil: vi.fn(async () => undefined),
  sendEvent: vi.fn(async (_id: string, e: { name: string; data: any }) => void h.sent.push(e)),
};
const call = (job: unknown, event: object) => (job as Handler).handler({ event, step });

beforeEach(() => {
  h.receipts.length = 0;
  h.sent.length = 0;
  h.seq = 0;
  h.enabled = true;
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('the ETA jobs are ported', () => {
  it.each(['eta-receipt-enqueue', 'eta-receipt-submit', 'eta-receipt-redrive'])('%s', id => {
    expect(PORTED_JOBS.has(id)).toBe(true);
    expect(decideRunForStore({ id } as never, DO_STORE)).toEqual({ run: true });
  });
});

describe('eta-receipt-enqueue on a DO store', () => {
  const event = { name: 'order/created', data: { orderId: 'o1', storeId: DO_STORE } };

  it('writes the receipt row through the DO writer and sends the submit event', async () => {
    expect(await call(etaReceiptEnqueue, event)).toBe('queued');
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]).toMatchObject({ orderId: 'o1', kind: 'sale', status: 'queued', seq: 1 });
    expect(h.sent.map(e => e.name)).toEqual(['eta/receipt.submit']);
  });

  it('double fire: the second delivery makes no row and no event', async () => {
    await call(etaReceiptEnqueue, event);
    expect(await call(etaReceiptEnqueue, event)).toBe('queued');
    expect(h.receipts).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('a store without the feature is skipped without touching the table', async () => {
    h.enabled = false;
    expect(await call(etaReceiptEnqueue, event)).toBe('skipped');
    expect(h.receipts).toHaveLength(0);
  });

  it('a refund with no sale receipt is skipped', async () => {
    const refund = { name: 'order/refunded', data: { orderId: 'o9', storeId: DO_STORE } };
    expect(await call(etaReceiptEnqueue, refund)).toBe('skipped');
  });
});

describe('eta-receipt-submit and -redrive on a DO store', () => {
  it('submit of a missing receipt ends without a write or a follow-up', async () => {
    const out = await call(etaReceiptSubmit, {
      name: 'eta/receipt.submit',
      data: { storeId: DO_STORE, receiptId: 'nope' },
    });
    expect(out).toBe('missing');
    expect(h.sent).toHaveLength(0);
  });

  it('submit of a queued receipt with the connection off fails it once, in the DO row', async () => {
    h.receipts.push({
      id: 'r1',
      storeId: DO_STORE,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
    });
    const ev = { name: 'eta/receipt.submit', data: { storeId: DO_STORE, receiptId: 'r1' } };
    // loadCredentials reads no connection credentials in this stand-in, so the attempt ends `failed`
    await call(etaReceiptSubmit, ev);
    expect(h.receipts[0].status).toBe('failed');
    expect(await call(etaReceiptSubmit, ev)).toBe('failed'); // double fire: a failed receipt is left alone
    expect(h.receipts[0].status).toBe('failed');
  });

  it('redrive sleeps until due, then re-sends the submit event', async () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    await call(etaReceiptRedrive, {
      name: 'eta/receipt.scheduled',
      data: { storeId: DO_STORE, receiptId: 'r1', at },
    });
    expect(step.sleepUntil).toHaveBeenCalled();
    expect(h.sent).toEqual([
      { name: 'eta/receipt.submit', data: { storeId: DO_STORE, receiptId: 'r1' } },
    ]);
  });
});
