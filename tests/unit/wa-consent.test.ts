/**
 * WA-CONSENT-1: WhatsApp marketing consent. Every write is attributed to a (store, buyer) by ONE
 * observer; an STOP (opt_out_changed) revokes but never re-enables; versions are monotonic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  find: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    storeWhatsAppConsent: {
      findUnique: h.find,
      upsert: h.upsert,
      update: h.update,
      updateMany: h.updateMany,
      create: h.create,
    },
  },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/inngest/send-after-commit', () => ({ sendEventAfterCommit: h.send }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buyerKeyFor } from '@ebda/shared';
import { applyOptOutChanged, WhatsAppConsentService } from '@api/lib/wa/consent';
import { consentChangeTarget, onConsentWrite } from '@api/lib/wa/consent-state';

const S = '11111111-1111-4111-8111-111111111111';
const K = 'e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd';

beforeEach(() => {
  process.env.SUITE_BUYER_KEY_SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
  h.find.mockReset().mockResolvedValue(null);
  h.upsert.mockReset().mockResolvedValue({});
  h.update.mockReset().mockResolvedValue({});
  h.send.mockReset().mockResolvedValue(undefined);
});

describe('consent writes are attributed and announced', () => {
  it('names the store and buyer for every write shape the service uses', () => {
    const w = { storeId_buyerKey: { storeId: S, buyerKey: K } };
    for (const [operation, args] of [
      ['upsert', { where: w }],
      ['update', { where: w, data: { granted: false } }],
      ['deleteMany', { where: { storeId: S, buyerKey: K } }],
      ['create', { data: { storeId: S, buyerKey: K } }],
    ] as const) {
      expect(
        consentChangeTarget({ model: 'StoreWhatsAppConsent', operation, args, result: null })
      ).toEqual({
        storeId: S,
        buyerKey: K,
      });
    }
  });

  it('ignores other models, and an unattributable write is NOT announced silently wrong', () => {
    onConsentWrite({ model: 'Order', operation: 'update', args: {}, result: {} });
    expect(h.send).not.toHaveBeenCalled();
    onConsentWrite({
      model: 'StoreWhatsAppConsent',
      operation: 'updateMany',
      args: { where: {} },
      result: {},
    });
    expect(h.send).not.toHaveBeenCalled();
    onConsentWrite({
      model: 'StoreWhatsAppConsent',
      operation: 'deleteMany',
      args: { where: { storeId: S, buyerKey: K } },
      result: {},
    });
    expect(h.send).toHaveBeenCalledWith(
      'wa-consent-changed',
      { name: 'wa/consent-changed', data: { storeId: S, buyerKey: K } },
      { ifUnhookable: 'send' }
    );
  });
});

describe('the service', () => {
  it('a tick is stored with source, locale and time; unticking withdraws', async () => {
    await WhatsAppConsentService.record(S, '+201001234567', {
      consent: true,
      source: 'checkout',
      locale: 'ar',
    });
    const a = h.upsert.mock.calls[0]![0];
    expect(a.where.storeId_buyerKey).toEqual({
      storeId: S,
      buyerKey: await buyerKeyFor(process.env.SUITE_BUYER_KEY_SECRET!, '+201001234567'),
    });
    expect(a.create).toMatchObject({ granted: true, grantedSource: 'checkout', locale: 'ar' });
    expect(a.create.grantedAt).toBeInstanceOf(Date);
    await WhatsAppConsentService.record(S, '+201001234567', { consent: false, source: 'checkout' });
    expect(h.upsert.mock.calls[1]![0].update).toMatchObject({
      granted: false,
      revokedSource: 'checkout',
    });
  });

  it('no phone, no row; no row means no consent', async () => {
    expect(
      await WhatsAppConsentService.record(S, 'n/a', { consent: true, source: 'checkout' })
    ).toBeNull();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(await WhatsAppConsentService.hasConsent(S, K)).toBe(false);
    h.find.mockResolvedValue({ granted: true });
    expect(await WhatsAppConsentService.hasConsent(S, K)).toBe(true);
  });
});

describe('whatsapp.opt_out_changed (v1.1)', () => {
  // A one-row table whose updateMany honours the `optOutVersion: { lt }` guard, like the database.
  function table(row: { optOutVersion: number; granted: boolean } | null) {
    let r = row;
    h.find.mockImplementation(async () => r);
    h.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (!r || !(r.optOutVersion < where.optOutVersion.lt)) return { count: 0 };
      r = { ...r, ...data };
      return { count: 1 };
    });
    h.create.mockImplementation(async ({ data }: any) => {
      r = { optOutVersion: data.optOutVersion, granted: data.granted };
      return {};
    });
    return () => r;
  }

  it('optedOut=true revokes (source whatsapp) and records the version, guarded IN the write', async () => {
    const get = table({ optOutVersion: 1, granted: true });
    expect(await applyOptOutChanged(S, K, true, 2)).toBe('applied');
    expect(get()).toMatchObject({ granted: false, optOutVersion: 2 });
    expect(h.updateMany.mock.calls[0]![0].where.optOutVersion).toEqual({ lt: 2 });
    expect(h.updateMany.mock.calls[0]![0].data).toMatchObject({ revokedSource: 'whatsapp' });
  });
  it('no row yet: created already opted out', async () => {
    const get = table(null);
    expect(await applyOptOutChanged(S, K, true, 1)).toBe('applied');
    expect(get()).toMatchObject({ granted: false, optOutVersion: 1 });
  });
  it('a forced P2002 on create still lands the opt-out via the version-guarded update', async () => {
    let r: { optOutVersion: number; granted: boolean } | null = null;
    h.find.mockImplementation(async () => r);
    h.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (!r || !(r.optOutVersion < where.optOutVersion.lt)) return { count: 0 };
      r = { ...r, ...data };
      return { count: 1 };
    });
    h.create.mockImplementation(async () => {
      // a concurrent event created the row first, with an OLDER version
      r = { optOutVersion: 1, granted: true };
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    });
    expect(await applyOptOutChanged(S, K, true, 2)).toBe('applied');
    expect(r).toMatchObject({ granted: false, optOutVersion: 2 });
  });
  it('any other create error is RETHROWN (the queue redelivers; a STOP is never dropped)', async () => {
    table(null);
    h.create.mockRejectedValue(new Error('connection reset'));
    await expect(applyOptOutChanged(S, K, true, 1)).rejects.toThrow('connection reset');
  });
  it('a stale or replayed version changes nothing, and the version never goes down', async () => {
    const get = table({ optOutVersion: 3, granted: false });
    expect(await applyOptOutChanged(S, K, true, 3)).toBe('ignored');
    expect(await applyOptOutChanged(S, K, true, 2)).toBe('ignored');
    expect(get()!.optOutVersion).toBe(3);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('optedOut=false never re-enables consent (version only)', async () => {
    const get = table({ optOutVersion: 1, granted: false });
    expect(await applyOptOutChanged(S, K, false, 2)).toBe('ignored');
    expect(get()).toMatchObject({ granted: false, optOutVersion: 2 });
  });
});
