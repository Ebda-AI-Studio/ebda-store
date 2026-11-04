// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit G-2: a plan-gated call must never hand a page the raw API text ("Request failed with status 403",
 * "Feature not available"). Pages render `error.message` as-is, so the client normalises it once, here.
 */
function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))
  );
}
async function loadApi() {
  vi.resetModules();
  return import('../api');
}
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.dir = '';
});

const RAW = /Request failed with status|Feature not available/;

describe('plan-gate errors never carry raw API text', () => {
  it.each([
    [
      'legacy string envelope',
      { success: false, error: 'Feature not available', code: 'FEATURE_DISABLED' },
    ],
  ])('403 %s -> Egyptian Arabic sentence in an RTL admin', async (_n, body) => {
    document.documentElement.dir = 'rtl';
    respond(403, body);
    const { apiGet } = await loadApi();
    const { error } = await apiGet('/api/v1/stores/s1/finance/dashboard');
    expect(error?.message).not.toMatch(RAW);
    expect(error?.message).toMatch(/باقتك/);
    expect(error?.status).toBe(403);
  });

  it('a bodiless 403 is a permission denial: its own sentence, never the plan upsell, never raw', async () => {
    document.documentElement.dir = 'rtl';
    respond(403, { success: false });
    const { apiGet } = await loadApi();
    const { error } = await apiGet('/api/v1/stores/s1/finance/dashboard');
    expect(error?.message).not.toMatch(RAW);
    expect(error?.message).not.toMatch(/باقتك/);
    expect(error?.message).toMatch(/مش مسموحلك/);
  });

  it('403 FEATURE_DISABLED in an LTR admin -> English plan sentence', async () => {
    respond(403, { success: false, error: 'Feature not available', code: 'FEATURE_DISABLED' });
    const { apiGet } = await loadApi();
    const { error } = await apiGet('/api/v1/stores/s1/stock/backorders');
    expect(error?.message).toMatch(/current plan/);
  });

  it('keeps the API localized text when the API sent one', async () => {
    document.documentElement.dir = 'rtl';
    respond(403, {
      success: false,
      error: 'Feature not available',
      code: 'FEATURE_DISABLED',
      upgradeTo: { code: 'growth', nameEn: 'Growth', nameAr: 'النمو' },
      messageAr: 'الميزة دي متاحة في باقة النمو.',
      messageEn: 'x',
    });
    const { apiGet } = await loadApi();
    const { error } = await apiGet('/api/v1/stores/s1/loyalty');
    expect(error?.message).toBe('الميزة دي متاحة في باقة النمو.');
  });

  it('leaves a real permission message alone', async () => {
    respond(403, {
      success: false,
      error: { code: 'FORBIDDEN', message: 'You cannot edit staff' },
    });
    const { apiGet } = await loadApi();
    const { error } = await apiGet('/api/v1/stores/s1/staff');
    expect(error?.message).toBe('You cannot edit staff');
  });
});
