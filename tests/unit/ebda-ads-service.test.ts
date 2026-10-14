/**
 * Ebda own-ads tracking, API side: hashing/normalisation, CAPI payload shape, dedup ids,
 * consent + unset-env no-ops, acquisition persistence shape. services/ebda-ads.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({ default: logger }));

import {
  acquisitionForAdmin,
  buildAcquisition,
  buildEbdaCapiEvent,
  ebdaAdsConfigOrLog,
  getEbdaAdsConfig,
  hashEmailForMeta,
  hashPhoneForMeta,
  normalizePhoneForMeta,
  readAcquisition,
  resetEbdaAdsLogForTests,
  sendEbdaCapiEvent,
  type EbdaAcquisition,
  type EbdaAdsEventInput,
} from '@api/services/ebda-ads.service';

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const CFG = { pixelId: '555', accessToken: 'tok_secret', testEventCode: undefined };

const acquisition: EbdaAcquisition = {
  v: 1,
  attribution: { utm_source: 'meta', utm_campaign: 'launch', fbclid: 'abc', first_seen: 1 },
  fbp: 'fb.1.1.2',
  fbc: 'fb.1.1.abc',
  phId: 'ph-1',
  consent: { analytics: true, marketing: true },
  ip: '203.0.113.9',
  ua: 'UA/1',
  capturedAt: '2026-10-14T00:00:00.000Z',
};
const input = (over: Partial<EbdaAdsEventInput> = {}): EbdaAdsEventInput => ({
  name: 'CompleteRegistration',
  eventId: 'reg_u1',
  userId: 'u1',
  email: '  Mona@Example.ORG ',
  phone: '01012345678',
  acquisition,
  now: new Date('2026-10-14T10:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetEbdaAdsLogForTests();
});

describe('hashing + normalisation (Meta spec)', () => {
  it('email: trim + lowercase, then SHA-256 hex', () => {
    expect(hashEmailForMeta('  Mona@Example.ORG ')).toBe(sha('mona@example.org'));
    expect(hashEmailForMeta('')).toBeNull();
    expect(hashEmailForMeta(null)).toBeNull();
  });
  it('phone: digits only, country code included, no + and no leading zero', () => {
    expect(normalizePhoneForMeta('01012345678')).toBe('201012345678');
    expect(normalizePhoneForMeta('+20 101 234 5678')).toBe('201012345678');
    expect(normalizePhoneForMeta('(0044) 7911-123456')).toBe('447911123456');
    expect(hashPhoneForMeta('01012345678')).toBe(sha('201012345678'));
    expect(normalizePhoneForMeta('12')).toBeNull();
    expect(normalizePhoneForMeta(null)).toBeNull();
  });
});

describe('CAPI payload shape', () => {
  it('CompleteRegistration: hashed pii, ids, no PII in the clear', () => {
    const e = buildEbdaCapiEvent(input());
    expect(e).toMatchObject({
      event_name: 'CompleteRegistration',
      event_id: 'reg_u1',
      action_source: 'website',
      event_time: Math.floor(new Date('2026-10-14T10:00:00Z').getTime() / 1000),
      event_source_url: 'https://store.ebda.app/verify-email',
    });
    expect(e.user_data).toMatchObject({
      em: [sha('mona@example.org')],
      ph: [sha('201012345678')],
      external_id: [sha('u1')],
      country: [sha('eg')],
      fbp: 'fb.1.1.2',
      fbc: 'fb.1.1.abc',
      client_ip_address: '203.0.113.9',
      client_user_agent: 'UA/1',
    });
    const wire = JSON.stringify(e);
    expect(wire).not.toContain('mona@example.org');
    expect(wire).not.toContain('01012345678');
    expect(e.custom_data).toEqual({ utm_source: 'meta', utm_campaign: 'launch' });
  });
  it('Purchase: EGP value in major units, plan, billing url', () => {
    const e = buildEbdaCapiEvent(
      input({
        name: 'Purchase',
        eventId: 'sub_b1',
        value: 299,
        currency: 'EGP',
        planCode: 'growth',
      })
    );
    expect(e.event_name).toBe('Purchase');
    expect(e.event_id).toBe('sub_b1');
    expect(e.custom_data).toMatchObject({ value: 299, currency: 'EGP', content_name: 'growth' });
    expect(e.event_source_url).toBe('https://store.ebda.app/billing');
  });
  it('StoreCreated carries no value', () => {
    const e = buildEbdaCapiEvent(input({ name: 'StoreCreated', eventId: 'store_s1' }));
    expect(e.event_name).toBe('StoreCreated');
    expect(e.custom_data).not.toHaveProperty('value');
  });
  it('omits absent identifiers instead of sending empties', () => {
    const e = buildEbdaCapiEvent(
      input({
        email: '',
        phone: null,
        acquisition: {
          ...acquisition,
          fbp: undefined,
          fbc: undefined,
          ip: undefined,
          ua: undefined,
        },
      })
    );
    expect(Object.keys(e.user_data).sort()).toEqual(['country', 'external_id']);
  });
});

describe('sendEbdaCapiEvent', () => {
  const ok = () =>
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ events_received: 1 }) });

  it('POSTs form-encoded to the pixel with the token in the body, not the URL', async () => {
    const f = ok();
    const r = await sendEbdaCapiEvent(input(), {
      config: CFG,
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(r).toEqual({ sent: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/555\/events$/);
    expect(url).not.toContain('tok_secret');
    const body = new URLSearchParams(init.body);
    expect(body.get('access_token')).toBe('tok_secret');
    expect(JSON.parse(body.get('data')!)[0].event_id).toBe('reg_u1');
    expect(body.has('test_event_code')).toBe(false);
  });
  it('adds test_event_code when configured', async () => {
    const f = ok();
    await sendEbdaCapiEvent(input(), {
      config: { ...CFG, testEventCode: 'TEST123' },
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(new URLSearchParams(f.mock.calls[0][1].body).get('test_event_code')).toBe('TEST123');
  });
  it('unset config: sends nothing, resolves', async () => {
    const f = ok();
    const r = await sendEbdaCapiEvent(input(), {
      config: null,
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(r).toEqual({ sent: false, reason: 'unconfigured' });
    expect(f).not.toHaveBeenCalled();
  });
  it('no marketing consent: sends nothing', async () => {
    const f = ok();
    const r = await sendEbdaCapiEvent(
      input({ acquisition: { ...acquisition, consent: { analytics: true, marketing: false } } }),
      { config: CFG, fetchImpl: f as unknown as typeof fetch }
    );
    expect(r).toEqual({ sent: false, reason: 'no_marketing_consent' });
    expect(f).not.toHaveBeenCalled();
  });
  it('throws on HTTP failure so Inngest retries', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(
      sendEbdaCapiEvent(input(), { config: CFG, fetchImpl: f as unknown as typeof fetch })
    ).rejects.toThrow(/500/);
  });
  it('throws when Meta 200s but did not take the event', async () => {
    const f = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ events_received: 0 }) });
    await expect(
      sendEbdaCapiEvent(input(), { config: CFG, fetchImpl: f as unknown as typeof fetch })
    ).rejects.toThrow(/events_received=0/);
  });
});

describe('config (env)', () => {
  it('needs both the pixel id and the token', () => {
    expect(getEbdaAdsConfig({})).toBeNull();
    expect(getEbdaAdsConfig({ EBDA_META_PIXEL_ID: '1' } as NodeJS.ProcessEnv)).toBeNull();
    expect(getEbdaAdsConfig({ EBDA_META_CAPI_TOKEN: 't' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      getEbdaAdsConfig({
        EBDA_META_PIXEL_ID: ' 1 ',
        EBDA_META_CAPI_TOKEN: 't',
        EBDA_META_TEST_EVENT_CODE: 'TEST1',
      } as NodeJS.ProcessEnv)
    ).toEqual({ pixelId: '1', accessToken: 't', testEventCode: 'TEST1' });
  });
  it('unset: logs exactly ONE info line however often it is asked', () => {
    for (let i = 0; i < 5; i++) expect(ebdaAdsConfigOrLog({})).toBeNull();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('acquisition persistence shape', () => {
  const req = { ip: '203.0.113.9', userAgent: 'UA/1' };
  const tracking = {
    attribution: { first_seen: 5, utm_source: 'meta', fbclid: 'abc', fbc: 'fb.1.5.abc', evil: 'x' },
    fbp: 'fb.1.1.2',
    phId: 'ph-1',
    consent: { analytics: true, marketing: true },
  };
  it('no tracking / declined -> nothing stored', () => {
    expect(buildAcquisition(undefined, req)).toBeNull();
    expect(buildAcquisition({ consent: { analytics: false, marketing: false } }, req)).toBeNull();
  });
  it('stores sanitised attribution, ids, consent and the server-observed ip/ua', () => {
    const a = buildAcquisition(tracking, req, new Date('2026-10-14T00:00:00Z'))!;
    expect(a.attribution).toEqual({
      first_seen: 5,
      utm_source: 'meta',
      fbclid: 'abc',
      fbc: 'fb.1.5.abc',
    });
    expect(a).toMatchObject({
      v: 1,
      fbp: 'fb.1.1.2',
      fbc: 'fb.1.5.abc',
      phId: 'ph-1',
      ip: '203.0.113.9',
      ua: 'UA/1',
    });
    expect(a.capturedAt).toBe('2026-10-14T00:00:00.000Z');
  });
  it('analytics-only consent keeps no marketing identifiers (ip, ua, fbp, fbc)', () => {
    const a = buildAcquisition(
      { ...tracking, consent: { analytics: true, marketing: false } },
      req
    )!;
    expect(a).not.toHaveProperty('ip');
    expect(a).not.toHaveProperty('ua');
    expect(a).not.toHaveProperty('fbp');
    expect(a).not.toHaveProperty('fbc');
    expect(a.phId).toBe('ph-1');
  });
  it('marketing-only consent keeps no PostHog id', () => {
    expect(
      buildAcquisition({ ...tracking, consent: { analytics: false, marketing: true } }, req)!
    ).not.toHaveProperty('phId');
  });
  it('round-trips through readAcquisition and tolerates junk', () => {
    const a = buildAcquisition(tracking, req)!;
    expect(readAcquisition(JSON.parse(JSON.stringify(a)))).toMatchObject({
      v: 1,
      consent: a.consent,
    });
    expect(readAcquisition(null)).toBeNull();
    expect(readAcquisition({ v: 2 })).toBeNull();
    expect(readAcquisition('x')).toBeNull();
  });
  it('the super-admin view hides ip, ua and Meta ids', () => {
    const view = acquisitionForAdmin({ acquisition: buildAcquisition(tracking, req) });
    expect(Object.keys(view!).sort()).toEqual(['attribution', 'capturedAt', 'consent']);
    expect(acquisitionForAdmin({ acquisition: null })).toBeNull();
  });
});
