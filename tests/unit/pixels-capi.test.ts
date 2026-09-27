/**
 * Unit tests — pixels-capi.service.ts
 *
 * What we test:
 *   1. hashEmail / hashPhone — correct SHA-256 normalisation
 *   2. sendPurchaseConversion
 *      - skips silently when no pixels configured
 *      - skips when accessToken is missing
 *      - skips when pixel is disabled
 *      - skips when accessToken is still the masked sentinel
 *      - builds the correct Meta CAPI request shape (currency, value÷1000, event_id=orderId,
 *        hashed email + phone, action_source, event_name)
 *      - builds the correct TikTok Events API request shape
 *      - passes test_event_code when configured
 *      - sends to both platforms in parallel (two fetch calls)
 *      - fails open: a Meta HTTP 500 logs the error but does NOT throw
 *      - fails open: a TikTok error-code response logs but does NOT throw
 *      - omits user_data fields when email/phone are absent
 *      - reads email/phone from shippingAddress when customer is null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// ── module mocks (must be hoisted before the service import) ──────────────────

// The service imports logger (pino), which isn't available in the bare worktree
// test environment. Mock the whole module so pino isn't required.
vi.mock('@api/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// The config module pulls from process.env — stub out enough for the service.
vi.mock('@api/config', () => ({
  config: {
    nodeEnv: 'test',
    encryptionKey: 'test-encryption-key-for-ci-32chars',
  },
}));

// ── helpers under test ────────────────────────────────────────────────────────

// Import after mocking so the service module picks up our mocks.
import {
  hashEmail,
  hashPhone,
  sendPurchaseConversion,
  isErasedCustomerOrder,
  type PurchaseOrderData,
} from '@api/services/pixels-capi.service';

// ── SHA-256 reference ─────────────────────────────────────────────────────────

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const ORDER: PurchaseOrderData = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  total: 5000, // 5.000 KWD
  currency: 'KWD',
  customer: { email: '  Test@Example.com  ', phone: '+965 9999-8888' },
  shippingAddress: null,
};

const META_PIXELS = {
  meta: {
    enabled: true,
    pixelId: 'PIXELMETA123',
    accessToken: 'EAAB_REAL_TOKEN_XYZ',
    testEventCode: 'TEST12345',
  },
};

const TIKTOK_PIXELS = {
  tiktok: {
    enabled: true,
    pixelId: 'PIXELTIKTOK456',
    accessToken: 'tiktok_real_token_abc',
  },
};

const BOTH_PIXELS = { ...META_PIXELS, ...TIKTOK_PIXELS };

const STORE_URL = 'https://www.example.com';

// ── mock setup ────────────────────────────────────────────────────────────────

// We mock fetch globally so no real HTTP calls happen.
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ events_received: 1, code: 0 }),
    text: async () => '{"events_received":1}',
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── hashEmail ─────────────────────────────────────────────────────────────────

describe('hashEmail', () => {
  it('lowercases and trims before hashing', () => {
    const result = hashEmail('  Test@Example.com  ');
    expect(result).toBe(sha256('test@example.com'));
  });

  it('is stable for the same canonical input', () => {
    expect(hashEmail('user@example.com')).toBe(hashEmail('USER@EXAMPLE.COM'));
  });

  it('returns 64-char hex string', () => {
    expect(hashEmail('a@b.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── hashPhone ─────────────────────────────────────────────────────────────────

describe('hashPhone', () => {
  it('strips spaces and dashes before hashing', () => {
    const result = hashPhone('+965 9999-8888');
    expect(result).toBe(sha256('+96599998888'));
  });

  it('strips parentheses and dots', () => {
    // '(965) 999.8888' → non-digit non-'+' stripped → '9659998888'
    expect(hashPhone('(965) 999.8888')).toBe(sha256('9659998888'));
  });

  it('returns 64-char hex string', () => {
    expect(hashPhone('+96512345678')).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── sendPurchaseConversion — skip cases ───────────────────────────────────────

describe('sendPurchaseConversion — skip conditions', () => {
  it('does nothing when pixels arg is null', async () => {
    await sendPurchaseConversion(null, ORDER, STORE_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when pixels is not an object', async () => {
    await sendPurchaseConversion('garbage', ORDER, STORE_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when meta is disabled', async () => {
    await sendPurchaseConversion(
      { meta: { enabled: false, pixelId: 'P1', accessToken: 'TOKEN' } },
      ORDER,
      STORE_URL
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips meta when accessToken is absent', async () => {
    await sendPurchaseConversion({ meta: { enabled: true, pixelId: 'P1' } }, ORDER, STORE_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips meta when accessToken is still the masked sentinel', async () => {
    await sendPurchaseConversion(
      { meta: { enabled: true, pixelId: 'P1', accessToken: 'EAAB****wXyz' } },
      ORDER,
      STORE_URL
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips tiktok when disabled', async () => {
    await sendPurchaseConversion(
      { tiktok: { enabled: false, pixelId: 'P2', accessToken: 'TOKEN' } },
      ORDER,
      STORE_URL
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips tiktok when accessToken is masked', async () => {
    await sendPurchaseConversion(
      { tiktok: { enabled: true, pixelId: 'P2', accessToken: 'tok****end' } },
      ORDER,
      STORE_URL
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Meta CAPI request shape ───────────────────────────────────────────────────

describe('sendPurchaseConversion — Meta CAPI payload', () => {
  it('posts to the correct Meta Graph API endpoint', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/PIXELMETA123/events');
  });

  // audit-followup #190: the plaintext long-lived token must never be part of
  // the URL — OpenTelemetry/Sentry auto-instrument outbound fetch calls and
  // record the full URL (including query string) in traces/breadcrumbs. It
  // goes in the JSON body instead, exactly like TikTok's request already
  // keeps its token out of its URL (in a header).
  it('sends the access token in the POST body, never in the URL', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('access_token');
    expect(url).not.toContain('EAAB_REAL_TOKEN_XYZ');
    const body = JSON.parse(init.body as string);
    expect(body.access_token).toBe('EAAB_REAL_TOKEN_XYZ');
  });

  it('sends event_name=Purchase and action_source=website', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].event_name).toBe('Purchase');
    expect(body.data[0].action_source).toBe('website');
  });

  it('uses orderId as event_id for deduplication', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].event_id).toBe(ORDER.id);
  });

  it('converts total milliKWD to decimal value', async () => {
    // ORDER.total = 5000 milliKWD → should be 5.000 KWD
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].custom_data.value).toBeCloseTo(5.0, 3);
    expect(body.data[0].custom_data.currency).toBe('KWD');
  });

  it('sends SHA-256-hashed email in user_data.em array', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].user_data.em).toEqual([sha256('test@example.com')]);
  });

  it('sends SHA-256-hashed phone in user_data.ph array', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].user_data.ph).toEqual([sha256('+96599998888')]);
  });

  it('passes test_event_code when configured', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.test_event_code).toBe('TEST12345');
  });

  it('omits test_event_code when not configured', async () => {
    const pixels = { meta: { ...META_PIXELS.meta, testEventCode: undefined } };
    await sendPurchaseConversion(pixels, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.test_event_code).toBeUndefined();
  });

  it('includes event_source_url', async () => {
    await sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].event_source_url).toBe(STORE_URL);
  });

  it('omits em/ph when customer and shippingAddress both have no email/phone', async () => {
    const order: PurchaseOrderData = {
      id: 'no-pii-order',
      total: 1000,
      currency: 'KWD',
      customer: null,
      shippingAddress: null,
    };
    await sendPurchaseConversion(META_PIXELS, order, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].user_data).toEqual({});
  });

  it('reads email and phone from shippingAddress when customer is null', async () => {
    const order: PurchaseOrderData = {
      id: 'addr-pii-order',
      total: 2000,
      currency: 'KWD',
      customer: null,
      shippingAddress: { email: 'guest@shop.com', phone: '+96599001122' },
    };
    await sendPurchaseConversion(META_PIXELS, order, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.data[0].user_data.em).toEqual([sha256('guest@shop.com')]);
    expect(body.data[0].user_data.ph).toEqual([sha256('+96599001122')]);
  });
});

// ── TikTok Events API request shape ──────────────────────────────────────────

describe('sendPurchaseConversion — TikTok Events API payload', () => {
  it('posts to the TikTok Events API URL', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/');
  });

  it('sends Access-Token header (not query param)', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Access-Token']).toBe('tiktok_real_token_abc');
  });

  it('sends event=CompletePayment for deduplication with client pixel', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe('CompletePayment');
  });

  it('uses orderId as event_id', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.event_id).toBe(ORDER.id);
  });

  it('sends correct value (milliKWD ÷ 1000) and currency', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.properties.value).toBeCloseTo(5.0, 3);
    expect(body.properties.currency).toBe('KWD');
  });

  it('hashes email in context.user.email', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.context.user.email).toBe(sha256('test@example.com'));
  });

  it('hashes phone in context.user.phone_number', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.context.user.phone_number).toBe(sha256('+96599998888'));
  });

  it('sends pixel_code', async () => {
    await sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.pixel_code).toBe('PIXELTIKTOK456');
  });
});

// ── Both platforms ────────────────────────────────────────────────────────────

describe('sendPurchaseConversion — both platforms', () => {
  it('fires two fetch calls when both meta and tiktok are configured', async () => {
    await sendPurchaseConversion(BOTH_PIXELS, ORDER, STORE_URL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── Fail-open behaviour ───────────────────────────────────────────────────────

describe('sendPurchaseConversion — fail-open', () => {
  it('does not throw when Meta CAPI returns HTTP 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL)).resolves.toBeUndefined();
  });

  it('does not throw when TikTok returns an error code in the body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 40001, message: 'Invalid pixel code' }),
      text: async () => '{"code":40001,"message":"Invalid pixel code"}',
    });

    await expect(sendPurchaseConversion(TIKTOK_PIXELS, ORDER, STORE_URL)).resolves.toBeUndefined();
  });

  it('continues to send TikTok even if Meta fails', async () => {
    // First call (Meta) fails
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'err' })
      // Second call (TikTok) succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0 }),
        text: async () => '{}',
      });

    await sendPurchaseConversion(BOTH_PIXELS, ORDER, STORE_URL);
    // Both were attempted
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not throw when fetch itself rejects (network error)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(sendPurchaseConversion(META_PIXELS, ORDER, STORE_URL)).resolves.toBeUndefined();
  });
});

describe('isErasedCustomerOrder — right-to-erasure CAPI suppression', () => {
  it('is true for the exact marker AuthService.eraseAccount writes', () => {
    expect(isErasedCustomerOrder({ anonymized: true })).toBe(true);
  });

  it('is false for a normal shipping address', () => {
    expect(
      isErasedCustomerOrder({
        firstName: 'Ahmad',
        email: 'shopper@example.com',
        city: 'Kuwait City',
      })
    ).toBe(false);
  });

  it('is false for null / undefined shippingAddress', () => {
    expect(isErasedCustomerOrder(null)).toBe(false);
    expect(isErasedCustomerOrder(undefined)).toBe(false);
  });

  it('is false when "anonymized" is present but not === true (truthy-but-not-boolean trap)', () => {
    expect(isErasedCustomerOrder({ anonymized: 'true' })).toBe(false);
    expect(isErasedCustomerOrder({ anonymized: 1 })).toBe(false);
  });

  it('is false for a non-object shippingAddress', () => {
    expect(isErasedCustomerOrder('anonymized')).toBe(false);
    expect(isErasedCustomerOrder(42)).toBe(false);
  });
});
