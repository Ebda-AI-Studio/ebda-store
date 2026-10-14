/**
 * Ebda own-ads tracking: the Inngest conversion function (first-payment rule, consent/erasure
 * skips, retry then mark-failed) and the fail-open emit helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger, db, sendMock } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  db: { user: null as unknown, ledger: null as unknown, earlier: 0 },
  sendMock: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({ default: logger }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, h: unknown) => ({ handler: h }), send: sendMock },
}));
vi.mock('@ebda/database', () => ({
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ user: { findUnique: async () => db.user } }),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      billingEvent: {
        findUnique: async () => db.ledger,
        count: async () => db.earlier,
      },
    }),
}));

import {
  attemptConversion,
  processEbdaConversion,
} from '@api/lib/inngest/functions/ebda-ads-conversion';
import { emitEbdaConversion } from '@api/services/ebda-ads-emit';
import { resetEbdaAdsLogForTests } from '@api/services/ebda-ads.service';

const acq = (over: Record<string, unknown> = {}) => ({
  v: 1,
  consent: { analytics: true, marketing: true },
  fbp: 'fb.1.1.2',
  phId: 'ph-1',
  capturedAt: 'x',
  ...over,
});
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  resetEbdaAdsLogForTests();
  process.env.EBDA_META_PIXEL_ID = '555';
  process.env.EBDA_META_CAPI_TOKEN = 'tok';
  process.env.EBDA_POSTHOG_KEY = 'phc';
  delete process.env.EBDA_META_TEST_EVENT_CODE;
  db.user = { email: 'a@b.co', phone: '01012345678', acquisition: acq(), deletedAt: null };
  db.ledger = {
    amountMinor: 29900,
    currency: 'EGP',
    planCode: 'growth',
    status: 'succeeded',
    createdAt: new Date(),
  };
  db.earlier = 0;
  fetchMock
    .mockReset()
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ events_received: 1 }) });
  vi.stubGlobal('fetch', fetchMock);
});

const bodyOf = (call: number) => new URLSearchParams(fetchMock.mock.calls[call][1].body);

describe('processEbdaConversion', () => {
  it('CompleteRegistration goes to Meta with the shared event id', async () => {
    const r = await processEbdaConversion({
      name: 'CompleteRegistration',
      eventId: 'reg_u1',
      userId: 'u1',
    });
    expect(r).toEqual({ status: 'sent' });
    expect(JSON.parse(bodyOf(0).get('data')!)[0]).toMatchObject({
      event_name: 'CompleteRegistration',
      event_id: 'reg_u1',
    });
  });

  it('first paid subscription: Purchase in EGP major units, then PostHog subscription_paid', async () => {
    const r = await processEbdaConversion({
      name: 'Purchase',
      eventId: 'sub_b1',
      userId: 'u1',
      storeId: 's1',
      billingEventId: 'b1',
    });
    expect(r).toEqual({ status: 'sent' });
    const ev = JSON.parse(bodyOf(0).get('data')!)[0];
    expect(ev.custom_data).toMatchObject({ value: 299, currency: 'EGP', content_name: 'growth' });
    expect(ev.event_id).toBe('sub_b1');
    const ph = fetchMock.mock.calls[1];
    expect(String(ph[0])).toContain('/capture/');
    expect(JSON.parse(ph[1].body)).toMatchObject({
      event: 'subscription_paid',
      distinct_id: 'ph-1',
    });
  });

  it('a later payment is not a conversion', async () => {
    db.earlier = 1;
    const r = await processEbdaConversion({
      name: 'Purchase',
      eventId: 'sub_b2',
      userId: 'u1',
      storeId: 's1',
      billingEventId: 'b2',
    });
    expect(r).toEqual({ status: 'skipped', reason: 'not_first_payment' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a payment that is not (or no longer) succeeded is skipped', async () => {
    db.ledger = { ...(db.ledger as object), status: 'refunded' };
    const r = await processEbdaConversion({
      name: 'Purchase',
      eventId: 'sub_b1',
      userId: 'u1',
      storeId: 's1',
      billingEventId: 'b1',
    });
    expect(r).toEqual({ status: 'skipped', reason: 'not_paid' });
  });

  it.each([
    ['no acquisition row (never consented)', { acquisition: null }, 'no_acquisition'],
    ['erased account', { deletedAt: new Date() }, 'user_gone'],
  ])('skips: %s', async (_n, patch, reason) => {
    db.user = { ...(db.user as object), ...patch };
    const r = await processEbdaConversion({
      name: 'CompleteRegistration',
      eventId: 'reg_u1',
      userId: 'u1',
    });
    expect(r).toEqual({ status: 'skipped', reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declined marketing: no Meta call', async () => {
    db.user = {
      ...(db.user as object),
      acquisition: acq({ consent: { analytics: true, marketing: false } }),
    };
    const r = await processEbdaConversion({
      name: 'CompleteRegistration',
      eventId: 'reg_u1',
      userId: 'u1',
    });
    expect(r).toEqual({ status: 'skipped', reason: 'no_marketing_consent' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unset env: no-op, one info log, no fetch', async () => {
    delete process.env.EBDA_META_PIXEL_ID;
    const r = await processEbdaConversion({
      name: 'CompleteRegistration',
      eventId: 'reg_u1',
      userId: 'u1',
    });
    expect(r).toEqual({ status: 'skipped', reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PostHog down does not fail the Meta send', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events_received: 1 }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const r = await processEbdaConversion({
      name: 'Purchase',
      eventId: 'sub_b1',
      userId: 'u1',
      storeId: 's1',
      billingEventId: 'b1',
    });
    expect(r).toEqual({ status: 'sent' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('missing ids are skipped, not thrown', async () => {
    expect(await processEbdaConversion({})).toEqual({
      status: 'skipped',
      reason: 'missing_fields',
    });
  });
});

describe('retry policy (attemptConversion)', () => {
  const failing = () =>
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'down' });
  const data = { name: 'CompleteRegistration' as const, eventId: 'reg_u1', userId: 'u1' };

  it('throws on early attempts so Inngest retries', async () => {
    failing();
    await expect(attemptConversion(data, 0)).rejects.toThrow(/500/);
    await expect(attemptConversion(data, 3)).rejects.toThrow(/500/);
    expect(logger.error).not.toHaveBeenCalled();
  });
  it('on the final attempt marks the failure and resolves (never throws)', async () => {
    failing();
    await expect(attemptConversion(data, 4)).resolves.toEqual({ status: 'failed' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'reg_u1', event: 'CompleteRegistration' }),
      expect.stringContaining('marked failed')
    );
  });
  it('a success on a retry is reported as sent', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'x' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events_received: 1 }) });
    await expect(attemptConversion(data, 0)).rejects.toThrow();
    await expect(attemptConversion(data, 1)).resolves.toEqual({ status: 'sent' });
  });
});

describe('emitEbdaConversion (fail-open enqueue)', () => {
  const req = { name: 'CompleteRegistration' as const, eventId: 'reg_u1', userId: 'u1' };
  it('unset env: queues nothing, logs one info line', async () => {
    delete process.env.EBDA_META_CAPI_TOKEN;
    await emitEbdaConversion(req);
    await emitEbdaConversion(req);
    expect(sendMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
  it('queues with the event id as the idempotency id', async () => {
    sendMock.mockResolvedValue({ ids: ['1'] });
    await emitEbdaConversion({
      ...req,
      name: 'Purchase',
      eventId: 'sub_b1',
      storeId: 's1',
      billingEventId: 'b1',
    });
    expect(sendMock).toHaveBeenCalledWith({
      id: 'sub_b1',
      name: 'ebda-ads/conversion.requested',
      data: {
        name: 'Purchase',
        eventId: 'sub_b1',
        userId: 'u1',
        storeId: 's1',
        billingEventId: 'b1',
      },
    });
  });
  it('an enqueue failure is logged and swallowed, never thrown into the user flow', async () => {
    sendMock.mockRejectedValue(new Error('inngest down'));
    await expect(emitEbdaConversion(req)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'reg_u1' }),
      expect.stringContaining('could not queue')
    );
  });
});
