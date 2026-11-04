/**
 * Carrier webhook authentication (shipping batch). Bosta signs nothing, so a callback is trusted
 * only when it carries BOTH secrets the store's encrypted credentials hold:
 *
 *   1. the per-store token in the URL path, and
 *   2. the header Ebda configured on the delivery (`webhookCustomHeaders`), whose value is DERIVED
 *      from the secret (never the secret itself),
 *
 * so a leaked URL alone is not enough. Every failure is the same `unauthorized` (no oracle) and
 * nothing is applied. Mutation proofs (docs/security/defence-mutation-record.md): removing the
 * token check, or the header check, turns the named tests red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const shipmentFindFirst = vi.fn();

vi.mock('@ebda/database', () => {
  const client = {
    shippingCarrierConfig: { findUnique: (...a: unknown[]) => findUnique(...a) },
    shipment: { findFirst: (...a: unknown[]) => shipmentFindFirst(...a) },
  };
  return {
    prisma: client,
    Prisma: {},
    currentStoreId: () => '11111111-1111-4111-8111-111111111111',
    withMoneyTx: (fn: (c: unknown) => unknown) => Promise.resolve(fn(client)),
    runInTenantContext: (_id: string, fn: () => unknown) => fn(),
    runInStoreScope: (_id: string, fn: () => unknown) => fn(),
    withStore: (_id: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(client)),
  };
});
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: vi.fn() },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));

import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { encryptCarrierBlob } from '@api/services/carriers/carrier-credentials';
import { BOSTA_WEBHOOK_HEADER, webhookHeaderValue } from '@api/services/carriers/bosta.carrier';

const STORE = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(48);
const BODY = {
  _id: 'x',
  trackingNumber: 5108002,
  state: 24,
  timeStamp: 1689252908261,
  type: 'SEND',
};

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({
    credentials: encryptCarrierBlob({ live: { apiKey: 'k' }, webhookSecret: SECRET }),
    settings: {},
  });
  shipmentFindFirst.mockResolvedValue(null);
});

const good = { [BOSTA_WEBHOOK_HEADER]: webhookHeaderValue(SECRET) };
const call = (token: string, headers: Record<string, string>, store = STORE) =>
  shippingCarrierService.processCarrierWebhook('bosta', store, token, BODY, headers);

describe('Bosta webhook: URL token AND derived header', () => {
  it('accepts a delivery with both, and reaches the shipment lookup', async () => {
    await expect(call(SECRET, good)).resolves.toBe('unknown_shipment');
    expect(shipmentFindFirst).toHaveBeenCalled();
  });

  it('wrong URL token is unauthorized (the header alone is not enough)', async () => {
    for (const bad of ['', 'a'.repeat(47), 'a'.repeat(49), 'b'.repeat(48), SECRET.slice(0, 10)]) {
      await expect(call(bad, good), bad).resolves.toBe('unauthorized');
    }
    expect(shipmentFindFirst).not.toHaveBeenCalled();
  });

  it('a leaked URL alone is not enough: no header, empty header, wrong header, the raw secret as header', async () => {
    await expect(call(SECRET, {})).resolves.toBe('unauthorized');
    await expect(call(SECRET, { [BOSTA_WEBHOOK_HEADER]: '' })).resolves.toBe('unauthorized');
    await expect(call(SECRET, { [BOSTA_WEBHOOK_HEADER]: 'nope' })).resolves.toBe('unauthorized');
    // the header value is derived: replaying the URL secret as the header must fail
    await expect(call(SECRET, { [BOSTA_WEBHOOK_HEADER]: SECRET })).resolves.toBe('unauthorized');
    // a header derived from ANOTHER store's secret
    await expect(
      call(SECRET, { [BOSTA_WEBHOOK_HEADER]: webhookHeaderValue('c'.repeat(48)) })
    ).resolves.toBe('unauthorized');
    expect(shipmentFindFirst).not.toHaveBeenCalled();
  });

  it('a carrier without a webhook, an unknown store id and a store without the carrier are the same unauthorized', async () => {
    await expect(
      shippingCarrierService.processCarrierWebhook('aramex', STORE, SECRET, BODY, good)
    ).resolves.toBe('unauthorized');
    await expect(
      shippingCarrierService.processCarrierWebhook('shipblu', STORE, SECRET, BODY, good)
    ).resolves.toBe('unauthorized');
    await expect(call(SECRET, good, 'not-a-uuid')).resolves.toBe('unauthorized');
    findUnique.mockResolvedValue(null);
    await expect(call(SECRET, good)).resolves.toBe('unauthorized');
    expect(shipmentFindFirst).not.toHaveBeenCalled();
  });

  it('an unreadable credential blob never authenticates anything', async () => {
    findUnique.mockResolvedValue({ credentials: 'garbage', settings: {} });
    await expect(call(SECRET, good)).resolves.toBe('unauthorized');
    await expect(call('', {})).resolves.toBe('unauthorized');
  });

  it('a verified delivery is ignored (200 path) when the state is not one we map', async () => {
    const r = await shippingCarrierService.processCarrierWebhook(
      'bosta',
      STORE,
      SECRET,
      { trackingNumber: 1, state: 9999 },
      good
    );
    expect(r).toBe('ignored');
  });
});

describe('graceful rotation keeps in-flight shipments working (SEC-8)', () => {
  const OLD = 'b'.repeat(48);
  const NEW = SECRET;
  const DAY = 24 * 60 * 60 * 1000;
  const rotatedAt = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
  const withPrevious = (daysAgo: number) =>
    findUnique.mockResolvedValue({
      credentials: encryptCarrierBlob({
        live: { apiKey: 'k' },
        webhookSecret: NEW,
        previousWebhook: { secret: OLD, rotatedAt: rotatedAt(daysAgo) },
      }),
      settings: {},
    });
  const oldHeaders = { [BOSTA_WEBHOOK_HEADER]: webhookHeaderValue(OLD) };

  it('accepts the NEW token with the new header, and the OLD token with the old header while a pre-rotation shipment is undelivered', async () => {
    withPrevious(3);
    shipmentFindFirst.mockResolvedValueOnce({ id: 'in-flight' }); // grace check
    await expect(call(OLD, oldHeaders)).resolves.toBe('unknown_shipment');
    shipmentFindFirst.mockReset();
    shipmentFindFirst.mockResolvedValue(null);
    await expect(call(NEW, good)).resolves.toBe('unknown_shipment');
  });

  it('the old URL token with the NEW header (or the reverse) is still refused', async () => {
    withPrevious(3);
    shipmentFindFirst.mockResolvedValue({ id: 'in-flight' });
    await expect(call(OLD, good)).resolves.toBe('unauthorized');
    await expect(call(NEW, oldHeaders)).resolves.toBe('unauthorized');
  });

  it('the old token stops working once every pre-rotation shipment is delivered', async () => {
    withPrevious(3);
    shipmentFindFirst.mockResolvedValue(null); // none in flight
    await expect(call(OLD, oldHeaders)).resolves.toBe('unauthorized');
  });

  it('the old token stops working after 30 days even with a shipment still in flight', async () => {
    withPrevious(31);
    shipmentFindFirst.mockResolvedValue({ id: 'in-flight' });
    await expect(call(OLD, oldHeaders)).resolves.toBe('unauthorized');
  });

  it('the in-flight lookup only counts shipments created before the rotation and not yet terminal', async () => {
    withPrevious(3);
    shipmentFindFirst.mockResolvedValueOnce({ id: 'x' });
    await call(OLD, oldHeaders);
    const where = shipmentFindFirst.mock.calls[0][0].where;
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(where.status.notIn).toEqual(expect.arrayContaining(['delivered']));
    expect(where.carrier).toBe('bosta');
  });

  it('the OLD token may only touch shipments created before the rotation and not yet terminal; the NEW token has no such limit', async () => {
    withPrevious(3);
    shipmentFindFirst.mockResolvedValueOnce({ id: 'in-flight' }).mockResolvedValue(null);
    await call(OLD, oldHeaders);
    const apply = shipmentFindFirst.mock.calls[1][0].where;
    expect(apply.createdAt.lt).toBeInstanceOf(Date);
    expect(apply.status.notIn).toEqual(expect.arrayContaining(['delivered']));
    shipmentFindFirst.mockReset();
    shipmentFindFirst.mockResolvedValue(null);
    await call(NEW, good);
    const applyNew = shipmentFindFirst.mock.calls[0][0].where;
    expect(applyNew.createdAt).toBeUndefined();
    expect(applyNew.status).toBeUndefined();
  });

  it('a blob without a previous secret rejects an unknown token as before', async () => {
    await expect(call(OLD, oldHeaders)).resolves.toBe('unauthorized');
  });
});

describe('rotateBlobWebhookSecret', () => {
  it('immediate by default (drops any previous secret); graceful keeps the old one with a timestamp', async () => {
    const { rotateBlobWebhookSecret } =
      await import('@api/services/carriers/carrier-connection.service');
    const { decryptCarrierBlob } = await import('@api/services/carriers/carrier-credentials');
    const start = encryptCarrierBlob({ live: { apiKey: 'k' }, webhookSecret: SECRET });
    const graceful = decryptCarrierBlob(rotateBlobWebhookSecret(start, {}, { grace: true }));
    expect(graceful.webhookSecret).not.toBe(SECRET);
    expect(graceful.previousWebhook?.secret).toBe(SECRET);
    expect(Date.parse(graceful.previousWebhook!.rotatedAt)).toBeGreaterThan(Date.now() - 5000);
    expect(graceful.live).toEqual({ apiKey: 'k' });
    const hard = decryptCarrierBlob(
      rotateBlobWebhookSecret(encryptCarrierBlob({ ...graceful }), {})
    );
    expect(hard.previousWebhook).toBeUndefined();
    expect(hard.webhookSecret).not.toBe(graceful.webhookSecret);
  });
});
