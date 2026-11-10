// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_AR, ERROR_EN, resolveErrorMessage } from '../error-messages';

/**
 * UX:C-1 / BE:E-2 client: every API error code has an Arabic sentence, applied inside apiRequest so no page edits
 * `error.message`. The server's own `details.messageAr` wins; English server text never reaches an RTL admin.
 */
const CODES = [
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'PARSE_ERROR',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'FORBIDDEN',
  'SERVER_ERROR',
  'UNAUTHORIZED',
  'CONFLICT',
];

describe('ERROR_AR / ERROR_EN tables', () => {
  it.each(CODES)('%s has an Arabic and an English sentence', code => {
    expect(ERROR_AR[code]).toMatch(/[؀-ۿ]/);
    expect(ERROR_EN[code]).toMatch(/^[A-Za-z]/);
  });
});

describe('resolveErrorMessage', () => {
  it('maps a code to Arabic and drops English server text', () => {
    const m = resolveErrorMessage({
      code: 'NOT_FOUND',
      status: 404,
      serverMessage: 'Product not found',
      locale: 'ar',
    });
    expect(m).toBe(ERROR_AR.NOT_FOUND);
  });
  it('falls back to the status class when the code is unknown', () => {
    expect(
      resolveErrorMessage({
        code: 'WEIRD',
        status: 502,
        serverMessage: 'Bad gateway',
        locale: 'ar',
      })
    ).toBe(ERROR_AR.SERVER_ERROR);
  });
  it('keeps server text that is already Arabic', () => {
    expect(
      resolveErrorMessage({
        code: 'VALIDATION_ERROR',
        status: 400,
        serverMessage: 'الاسم مطلوب',
        locale: 'ar',
      })
    ).toBe('الاسم مطلوب');
  });
  it('bilingual details win over the map', () => {
    expect(
      resolveErrorMessage({
        code: 'RATE_LIMITED',
        status: 429,
        serverMessage: 'جرّب بعد ٣٠ ثانية',
        locale: 'ar',
        hasBilingualDetails: true,
      })
    ).toBe('جرّب بعد ٣٠ ثانية');
  });
  it('English locale keeps specific server text but replaces developer strings', () => {
    expect(
      resolveErrorMessage({
        code: 'CONFLICT',
        status: 409,
        serverMessage: 'SKU already used',
        locale: 'en',
      })
    ).toBe('SKU already used');
    expect(
      resolveErrorMessage({
        code: 'NETWORK_ERROR',
        status: 0,
        serverMessage: 'Failed to fetch',
        locale: 'en',
      })
    ).toBe(ERROR_EN.NETWORK_ERROR);
  });
  it('an unknown 4xx without a mapped code keeps the server text', () => {
    expect(
      resolveErrorMessage({ code: 'X', status: 418, serverMessage: 'teapot', locale: 'en' })
    ).toBe('teapot');
  });
});

describe('apiRequest applies the map (forced 429, 400, 502 non-JSON, offline)', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    document.documentElement.dir = 'rtl';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.dir = '';
  });
  const load = async () => {
    vi.resetModules();
    return import('../api');
  };
  const respond = (status: number, body: unknown, json = true) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: status < 400,
        status,
        json: async () => {
          if (!json) throw new Error('not json');
          return body;
        },
      }))
    );

  it('429', async () => {
    respond(429, { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    const { apiGet } = await load();
    expect((await apiGet('/x')).error?.message).toBe(ERROR_AR.RATE_LIMITED);
  });
  it('429 with details.messageAr keeps the server sentence', async () => {
    respond(429, {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many',
        details: { messageAr: 'استنى ٣٠ ثانية', messageEn: 'Wait 30s' },
      },
    });
    const { apiGet } = await load();
    expect((await apiGet('/x')).error?.message).toBe('استنى ٣٠ ثانية');
  });
  it('400 validation', async () => {
    respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid input' } });
    const { apiPost } = await load();
    expect((await apiPost('/x', {})).error?.message).toBe(ERROR_AR.VALIDATION_ERROR);
  });
  it('502 non-JSON', async () => {
    respond(502, null, false);
    const { apiGet } = await load();
    const r = await apiGet('/x');
    expect(r.error?.code).toBe('PARSE_ERROR');
    expect(r.error?.message).toBe(ERROR_AR.PARSE_ERROR);
  });
  it('offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const { apiGet } = await load();
    expect((await apiGet('/x')).error?.message).toBe(ERROR_AR.NETWORK_ERROR);
  });
});

// 2026-11-10 P1 (Ruling ADMIN-ERR-1): the onboarding photo upload answered 500 and the Arabic page printed the API's raw
// "Internal server error". The upload reads its XHR itself, so it goes through localizedApiMessage, not apiRequest.
describe('a refusal read outside apiRequest (uploads, raw fetches)', () => {
  const PROD_500 = {
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'r' },
  };
  afterEach(() => {
    document.documentElement.dir = '';
  });
  it('a 500 upload shows the Arabic sentence in the Arabic UI, never the server text', async () => {
    document.documentElement.dir = 'rtl';
    const { uploadErrorText } = await import('../../hooks/useImageUpload');
    expect(uploadErrorText(PROD_500, 'فشل رفع الصورة (500)', 500)).toBe(ERROR_AR.SERVER_ERROR);
  });
  it('a 500 upload shows the English sentence in the English UI, never the server text', async () => {
    const { uploadErrorText } = await import('../../hooks/useImageUpload');
    expect(uploadErrorText(PROD_500, 'Upload failed (500)', 500)).toBe(ERROR_EN.SERVER_ERROR);
  });
  it('INTERNAL_ERROR without a status still never prints the server text', async () => {
    document.documentElement.dir = 'rtl';
    const { localizedApiMessage } = await import('../api');
    expect(localizedApiMessage('INTERNAL_ERROR', 'Internal server error', undefined)).toBe(
      ERROR_AR.INTERNAL_ERROR
    );
  });
  it('bilingual details still win (byte-sniff refusals)', async () => {
    document.documentElement.dir = 'rtl';
    const { localizedApiMessage } = await import('../api');
    expect(
      localizedApiMessage(
        'INVALID_IMAGE',
        'Not an image',
        { messageAr: 'الملف ده مش صورة.', messageEn: 'Not an image.' },
        400
      )
    ).toBe('الملف ده مش صورة.');
  });
  it('an unknown 4xx with English server text shows the generic Arabic sentence in the Arabic UI', () => {
    expect(
      resolveErrorMessage({
        code: 'X',
        status: 400,
        serverMessage: 'Folder x is not allowed',
        locale: 'ar',
      })
    ).toBe(ERROR_AR.REQUEST_FAILED);
  });
  it('an Arabic caller fallback survives an unknown code', () => {
    expect(
      resolveErrorMessage({ code: 'X', status: 400, serverMessage: 'فشل الرفع', locale: 'ar' })
    ).toBe('فشل الرفع');
  });
  it('apiRequest: a 500 INTERNAL_ERROR in the Arabic UI', async () => {
    document.documentElement.dir = 'rtl';
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => PROD_500 }))
    );
    vi.resetModules();
    const { apiPost } = await import('../api');
    expect((await apiPost('/x', {})).error?.message).toBe(ERROR_AR.SERVER_ERROR);
    vi.unstubAllGlobals();
  });
});
