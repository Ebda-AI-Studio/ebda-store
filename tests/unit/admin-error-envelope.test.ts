/**
 * A bare-string `error` is invisible to the admin client.
 *
 * THE DEFECT, REPORTED FOUR TIMES
 *
 * `apps/admin/src/lib/api.ts` normalises every failure as
 * `{ code: data.error?.code || 'SERVER_ERROR', message: data.error?.message || … }`.
 * When the server answers `{ success: false, error: 'WEBHOOK_ALREADY_PROCESSED' }`
 * — `error` a STRING — `data.error?.code` is `undefined`, so the client sees
 * `SERVER_ERROR` and "Request failed with status 409".
 *
 * The webhook-events page guards on
 * `if (!force && res.error.code === 'WEBHOOK_ALREADY_PROCESSED')`
 * (apps/admin/src/app/webhook-events/page.tsx). That branch could never be
 * true, so the deliberate force-replay escape hatch — the headline capability
 * of that feature — was dead from the day it shipped. Issues #553, #557, #582
 * and #617 are four reports of this one mechanism.
 *
 * It failed SAFE (it blocked re-processing rather than double-applying a
 * payment), which is why it sat this long.
 *
 * These tests drive the REAL client normaliser against both envelopes. A source
 * grep would only prove the characters changed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

function makeLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}
vi.stubGlobal('localStorage', makeLocalStorage());
vi.stubGlobal('window', { localStorage: makeLocalStorage(), location: { pathname: '/x' } });

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    clone() {
      return this;
    },
  } as unknown as Response;
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('the admin client can only read an OBJECT error', () => {
  it('resolves the code from the standard envelope', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonRes(409, {
        success: false,
        error: {
          code: 'WEBHOOK_ALREADY_PROCESSED',
          message: 'This webhook is already processed. Re-send force:true to replay it anyway.',
        },
      })
    ) as never;
    const { apiRequest } = await import('@admin/lib/api');

    const res = await apiRequest('/admin/webhook-events/abc/replay', { method: 'POST' });

    // The exact comparison the webhook-events page makes.
    expect(res.error?.code).toBe('WEBHOOK_ALREADY_PROCESSED');
    expect(res.error?.message).toMatch(/force:true/);
  });

  it('CANNOT resolve it from a bare string — the shape this PR removes', async () => {
    // The negative control, and the whole finding in one assertion. Keep it:
    // it is what proves the fix is load-bearing rather than cosmetic.
    globalThis.fetch = vi.fn(async () =>
      jsonRes(409, {
        success: false,
        error: 'WEBHOOK_ALREADY_PROCESSED',
        message: 'This webhook is already processed.',
      })
    ) as never;
    const { apiRequest } = await import('@admin/lib/api');

    const res = await apiRequest('/admin/webhook-events/abc/replay', { method: 'POST' });

    expect(res.error?.code).toBe('SERVER_ERROR');
    expect(res.error?.code).not.toBe('WEBHOOK_ALREADY_PROCESSED');
  });

  it('resolves the 404 code too', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonRes(404, {
        success: false,
        error: { code: 'WEBHOOK_EVENT_NOT_FOUND', message: 'Webhook event not found' },
      })
    ) as never;
    const { apiRequest } = await import('@admin/lib/api');

    expect((await apiRequest('/admin/webhook-events/abc/replay')).error?.code).toBe(
      'WEBHOOK_EVENT_NOT_FOUND'
    );
  });
});
