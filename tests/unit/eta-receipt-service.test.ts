/**
 * ETA e-receipt service: enqueue gating, fail-fast, build + submit + verdict, retry/late, secrets.
 * In-memory tenant tables stand in for Prisma (the service uses only portable ORM calls).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  conn: [] as any[],
  rec: [] as any[],
  orders: [] as any[],
  flag: true,
  sendFails: false,
  sent: [] as any[],
  alerts: [] as any[],
  seq: 0,
}));

const match = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as any;
      if ('not' in o) return row[k] !== o.not && !(o.not === null && row[k] == null);
      if ('notIn' in o) return !o.notIn.includes(row[k]);
      if ('in' in o) return o.in.includes(row[k]);
      if ('gt' in o) return row[k] > o.gt;
    }
    return row[k] === v;
  });
const table = (rows: any[]) => ({
  findFirst: async ({ where }: any = {}) => rows.find(r => match(r, where)) ?? null,
  findMany: async ({ where }: any = {}) => rows.filter(r => match(r, where)),
  create: async ({ data }: any) => {
    if (
      rows === h.rec &&
      rows.some(
        r =>
          r.storeId === data.storeId &&
          r.orderId === data.orderId &&
          r.kind === data.kind &&
          r.seq === data.seq
      )
    )
      throw new Error('unique');
    const row = { id: `id${++h.seq}`, attempts: 0, createdAt: new Date(), ...data };
    rows.push(row);
    return row;
  },
  update: async ({ where, data }: any) =>
    Object.assign(
      rows.find(r => r.id === where.id),
      data
    ),
  updateMany: async ({ where, data }: any) => {
    const hit = rows.filter(r => match(r, where));
    hit.forEach(r => Object.assign(r, data));
    return { count: hit.length };
  },
});
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: any) =>
    fn({ etaConnection: table(h.conn), etaReceipt: table(h.rec), order: table(h.orders) }),
}));
vi.mock('@api/services/encryption.service', () => ({
  encryption: { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => h.flag },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: async (e: any) => {
      if (h.sendFails) throw new Error('inngest down');
      h.sent.push(e);
    },
  },
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: async (a: any) => {
    h.alerts.push(a);
  },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: async () => undefined }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { EtaReceiptService } from '@api/services/eta-receipt.service';
import { EtaClient } from '@api/lib/eta/client';

const S = 'store1';
const input = {
  enabled: true,
  environment: 'preprod',
  clientId: 'cid-1234',
  clientSecret: 'secret-9999',
  posSerial: 'POS-1',
  posPreSharedKey: 'psk-5555',
  branchCode: '0',
  activityCode: '4719',
  defaultItemCode: 'EG-674859545-1',
  address: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas', buildingNumber: '5' },
};
const order = (o: any = {}) => ({
  id: 'o1',
  storeId: S,
  orderNumber: 'EB-1',
  createdAt: new Date('2026-10-26T09:00:00Z'),
  currency: 'EGP',
  discount: 0,
  shipping: 0,
  codFee: 0,
  extraAmount: 0,
  tax: 2800,
  total: 22800,
  taxableAmount: 20000,
  taxRateBps: 1400,
  sellerTaxRegistrationNumber: '674859545',
  sellerTaxLegalName: 'Nile Shop',
  shippingAddress: { firstName: 'Mona', lastName: 'Ali', phone: '010' },
  items: [{ productId: 'p1', productName: 'Lamp', sku: 'L1', quantity: 2, total: 20000 }],
  payments: [{ provider: 'paymob' }],
  ...o,
});
const fakeClient = (submit: any, verdict?: any) =>
  ({
    submitReceipts: vi.fn(async () => (typeof submit === 'function' ? submit() : submit)),
    getSubmission: vi.fn(async () => verdict),
  }) as unknown as EtaClient;

beforeEach(() => {
  h.conn.length = 0;
  h.rec.length = 0;
  h.orders.length = 0;
  h.sent.length = 0;
  h.alerts.length = 0;
  h.flag = true;
  h.sendFails = false;
  h.seq = 0;
  h.orders.push(order());
});

describe('connection', () => {
  it('stores secrets encrypted, returns them masked, and keeps them when a masked value is sent back', async () => {
    const v = await EtaReceiptService.saveConnection(S, input, { userId: 'u1' });
    expect(v.clientSecret).toBe('****9999');
    expect(h.conn[0].credentialsEnc.startsWith('enc:')).toBe(true);
    expect(JSON.stringify(v)).not.toContain('secret-9999');
    await EtaReceiptService.saveConnection(
      S,
      { ...input, clientId: '****1234', clientSecret: '****9999', posPreSharedKey: undefined },
      { userId: 'u1' }
    );
    const saved = JSON.parse(h.conn[0].credentialsEnc.slice(4));
    expect(saved).toMatchObject({
      clientId: 'cid-1234',
      clientSecret: 'secret-9999',
      preSharedKey: 'psk-5555',
    });
  });
  it('rejects unknown keys and a first save without a secret', async () => {
    await expect(
      EtaReceiptService.saveConnection(S, { ...input, extra: 1 }, { userId: 'u' })
    ).rejects.toThrow();
    await expect(
      EtaReceiptService.saveConnection(S, { ...input, clientSecret: undefined }, { userId: 'u' })
    ).rejects.toThrow(/required/);
  });
});

describe('enqueue', () => {
  it('does nothing while the feature is off (default)', async () => {
    h.flag = false;
    expect(await EtaReceiptService.enqueueSale(S, 'o1')).toBe('skipped');
    expect(h.rec).toHaveLength(0);
  });
  it('does nothing without an enabled connection or for a non-VAT order', async () => {
    expect(await EtaReceiptService.enqueueSale(S, 'o1')).toBe('skipped');
    await EtaReceiptService.saveConnection(S, input, { userId: 'u' });
    h.orders[0].sellerTaxRegistrationNumber = null;
    expect(await EtaReceiptService.enqueueSale(S, 'o1')).toBe('skipped');
  });
  it('queues once (idempotent) and sends the job event', async () => {
    await EtaReceiptService.saveConnection(S, input, { userId: 'u' });
    expect(await EtaReceiptService.enqueueSale(S, 'o1')).toBe('queued');
    expect(await EtaReceiptService.enqueueSale(S, 'o1')).toBe('queued');
    expect(h.rec).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ name: 'eta/receipt.submit', data: { storeId: S } });
  });
  it('fails fast: a failed send marks the row failed, never an orphan queued', async () => {
    await EtaReceiptService.saveConnection(S, input, { userId: 'u' });
    h.sendFails = true;
    await expect(EtaReceiptService.enqueueSale(S, 'o1')).rejects.toThrow('inngest down');
    expect(h.rec[0]).toMatchObject({ status: 'failed', errorCode: 'enqueue_failed' });
  });
});

describe('processReceipt', () => {
  const ready = async () => {
    await EtaReceiptService.saveConnection(S, input, { userId: 'u' });
    await EtaReceiptService.enqueueSale(S, 'o1');
    return h.rec[0].id as string;
  };
  const now = new Date('2026-10-26T10:00:00Z');

  it('builds a Receipt v1.2, submits it, then accepts on a Valid verdict (QR only then)', async () => {
    const id = await ready();
    const sub = fakeClient({ kind: 'ok', submissionUuid: 'SUB', accepted: [], rejected: [] });
    expect(await EtaReceiptService.processReceipt(S, id, now, undefined, sub)).toBe('submitted');
    const row = h.rec[0];
    expect(row.uuid).toMatch(/^[0-9a-f]{64}$/);
    expect(row.document.documentType.receiptType).toBe('s');
    expect(row.deadlineAt.getTime()).toBe(now.getTime() + 24 * 3600 * 1000);
    expect((await EtaReceiptService.listForOrder(S, 'o1'))[0].qr).toBeNull();

    const later = new Date(now.getTime() + 61_000);
    const ver = fakeClient(null, {
      kind: 'done',
      receipts: [{ uuid: row.uuid, status: 'Valid', longId: 'LONG' }],
    });
    expect(await EtaReceiptService.processReceipt(S, id, later, undefined, ver)).toBe('accepted');
    const [listed] = await EtaReceiptService.listForOrder(S, 'o1');
    expect(listed.longId).toBe('LONG');
    expect(listed.qr).toContain('https://preprod.invoicing.eta.gov.eg/receipts/search/');
    expect(listed.qr).toContain('#Total:228,IssuerRIN:674859545');
  });

  it('keeps the same document and uuid across a retry', async () => {
    const id = await ready();
    await EtaReceiptService.processReceipt(
      S,
      id,
      now,
      undefined,
      fakeClient({ kind: 'retry', reason: 'throttled', afterMs: 5000 })
    );
    const uuid = h.rec[0].uuid;
    expect(h.rec[0]).toMatchObject({ status: 'retrying' });
    const next = new Date(now.getTime() + 6000);
    await EtaReceiptService.processReceipt(
      S,
      id,
      next,
      undefined,
      fakeClient({ kind: 'ok', submissionUuid: 'S', accepted: [], rejected: [] })
    );
    expect(h.rec[0].uuid).toBe(uuid);
    expect(h.rec[0].status).toBe('submitted');
  });

  it('does not attempt before nextAttemptAt', async () => {
    const id = await ready();
    await EtaReceiptService.processReceipt(
      S,
      id,
      now,
      undefined,
      fakeClient({ kind: 'retry', reason: 'x', afterMs: 60000 })
    );
    const c = fakeClient({ kind: 'ok', submissionUuid: 'S', accepted: [], rejected: [] });
    expect(
      await EtaReceiptService.processReceipt(S, id, new Date(now.getTime() + 1000), undefined, c)
    ).toBe('retrying');
    expect((c as any).submitReceipts).not.toHaveBeenCalled();
  });

  it('marks failed (not submitted) when the order cannot be mapped to a matching receipt', async () => {
    const id = await ready();
    h.orders[0].total = 99999;
    const c = fakeClient({ kind: 'ok', submissionUuid: 'S', accepted: [], rejected: [] });
    expect(await EtaReceiptService.processReceipt(S, id, now, undefined, c)).toBe('failed');
    expect(h.rec[0].errorCode).toBe('ETA_TOTAL_MISMATCH');
    expect((c as any).submitReceipts).not.toHaveBeenCalled();
  });

  it('goes late past 24 h with an alert, and stops when the connection is turned off', async () => {
    const id = await ready();
    await EtaReceiptService.processReceipt(
      S,
      id,
      now,
      undefined,
      fakeClient({ kind: 'retry', reason: 'network', afterMs: 1000 })
    );
    const way = new Date(now.getTime() + 25 * 3600 * 1000);
    expect(
      await EtaReceiptService.processReceipt(
        S,
        id,
        way,
        undefined,
        fakeClient({ kind: 'ok', submissionUuid: 'S', accepted: [], rejected: [] })
      )
    ).toBe('late');
    expect(h.alerts.some(a => a.level === 'p1')).toBe(true);

    h.rec.length = 0;
    h.sent.length = 0;
    const id2 = await ready();
    h.conn[0].enabled = false;
    expect(await EtaReceiptService.processReceipt(S, id2, now, undefined, fakeClient(null))).toBe(
      'failed'
    );
    expect(h.rec[0].errorCode).toBe('ETA_NOT_CONNECTED');
  });

  it('re-issues a rejected receipt as seq 2 with referenceOldUUID, once', async () => {
    const id = await ready();
    await EtaReceiptService.processReceipt(
      S,
      id,
      now,
      undefined,
      fakeClient(() => ({
        kind: 'ok',
        submissionUuid: 'S',
        accepted: [],
        rejected: [{ uuid: h.rec[0].uuid, receiptNumber: 'EB-1', error: 'bad' }],
      }))
    );
    expect(h.rec[0].status).toBe('rejected');
    expect(await EtaReceiptService.retry(S, id)).toBe(true);
    expect(await EtaReceiptService.retry(S, id)).toBe(false);
    const row2 = h.rec[1];
    expect(row2.seq).toBe(2);
    await EtaReceiptService.processReceipt(
      S,
      row2.id,
      new Date(now.getTime() + 5000),
      undefined,
      fakeClient({ kind: 'ok', submissionUuid: 'S2', accepted: [], rejected: [] })
    );
    expect(h.rec[1].document.header.referenceOldUUID).toBe(h.rec[0].uuid);
    expect(h.rec[1].uuid).not.toBe(h.rec[0].uuid);
  });
});

describe('returns', () => {
  it('whole-order refund queues a return; partial refund is manual and alerts', async () => {
    await EtaReceiptService.saveConnection(S, input, { userId: 'u' });
    await EtaReceiptService.enqueueSale(S, 'o1');
    expect(await EtaReceiptService.enqueueReturn(S, 'o1', true)).toBe('manual');
    expect(h.rec.find(r => r.kind === 'return').status).toBe('manual');
    h.rec.splice(1, 1);
    expect(await EtaReceiptService.enqueueReturn(S, 'o1', false)).toBe('queued');
  });
});
