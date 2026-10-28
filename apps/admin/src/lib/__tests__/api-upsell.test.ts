// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A 402 is the API asking the merchant to pay or upgrade. The client must
 * (a) read the code from either error envelope, (b) hand back the message in
 * the UI language for ANY code that carries both languages, and (c) tell the
 * shell via `ebda:upsell` so one dialog serves every screen.
 */
function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status < 400,
      status,
      json: async () => body,
    }))
  );
}

async function loadApi() {
  vi.resetModules();
  return import('../api');
}

const upsells: CustomEvent[] = [];
const onUpsell = (e: Event) => upsells.push(e as CustomEvent);

beforeEach(() => {
  upsells.length = 0;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  window.addEventListener('ebda:upsell', onUpsell);
});
afterEach(() => {
  window.removeEventListener('ebda:upsell', onUpsell);
  vi.unstubAllGlobals();
  document.documentElement.dir = '';
});

const details = {
  messageEn: 'You reached your product limit.',
  messageAr: 'وصلت إلى حد المنتجات.',
  upgradeTo: { code: 'growth', nameEn: 'Growth', nameAr: 'النمو' },
  limitKey: 'maxProducts',
};

describe('apiRequest 402 handling', () => {
  it('dispatches ebda:upsell with the code, message, upgrade target and limit key', async () => {
    respond(402, {
      success: false,
      error: { code: 'PLAN_LIMIT_REACHED', message: 'raw', details },
    });
    const { apiPost } = await loadApi();
    const { error } = await apiPost('/api/v1/stores/s1/products', { name: 'x' });
    expect(error?.code).toBe('PLAN_LIMIT_REACHED');
    expect(error?.message).toBe('You reached your product limit.');
    expect(upsells).toHaveLength(1);
    expect(upsells[0].detail).toEqual({
      code: 'PLAN_LIMIT_REACHED',
      message: 'You reached your product limit.',
      upgradeTo: details.upgradeTo,
      limitKey: 'maxProducts',
    });
  });

  it('localizes ANY code that carries both languages (not only PLAN_LIMIT_REACHED), Arabic under RTL', async () => {
    document.documentElement.dir = 'rtl';
    respond(402, {
      success: false,
      error: {
        code: 'PAYMENT_METHOD_REQUIRED',
        message: 'raw english',
        details: { messageEn: 'Add a payment method', messageAr: 'أضف طريقة دفع', upgradeTo: null },
      },
    });
    const { apiPost } = await loadApi();
    const { error } = await apiPost('/api/v1/onboarding/stores/s1/go-live');
    expect(error?.message).toBe('أضف طريقة دفع');
    expect(upsells[0].detail).toMatchObject({ code: 'PAYMENT_METHOD_REQUIRED', upgradeTo: null });
  });

  it('reads the code from the legacy { error: "string", code } envelope', async () => {
    respond(402, { error: 'Subscription required', code: 'SUBSCRIPTION_REQUIRED' });
    const { apiGet } = await loadApi();
    const { error } = await apiGet('/api/v1/stores/s1/products');
    expect(error).toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'Subscription required',
      status: 402,
    });
    expect(upsells[0].detail).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', upgradeTo: null });
  });

  it('does not fire the upsell for other errors, and keeps their message untouched', async () => {
    respond(409, {
      success: false,
      error: { code: 'NOT_TRIALING', message: 'Not trialing', details },
    });
    const { apiPut } = await loadApi();
    const { error } = await apiPut('/api/v1/stores/s1/billing/trial-plan', {});
    expect(upsells).toHaveLength(0);
    // details with both languages are localized for every code now (English here).
    expect(error?.code).toBe('NOT_TRIALING');
  });

  it('raises the upsell for a 403 FEATURE_DISABLED only when the API names the plan that unlocks it', async () => {
    respond(403, {
      success: false,
      error: 'Feature not available',
      code: 'FEATURE_DISABLED',
      feature: 'loyalty',
      upgradeTo: { code: 'growth', nameEn: 'Growth', nameAr: 'النمو' },
      messageEn: 'This feature is available on the Growth plan.',
      messageAr: 'الميزة دي متاحة في باقة النمو.',
    });
    const { apiGet } = await loadApi();
    const { error } = await apiGet('/api/v1/stores/s1/loyalty');
    expect(error?.status).toBe(403);
    expect(upsells).toHaveLength(1);
    expect(upsells[0].detail).toMatchObject({
      code: 'FEATURE_DISABLED',
      message: 'This feature is available on the Growth plan.',
      upgradeTo: { code: 'growth' },
    });
  });

  it('stays silent for a FEATURE_DISABLED that is a toggle (no upgrade target)', async () => {
    respond(403, {
      success: false,
      error: 'Feature not available',
      code: 'FEATURE_DISABLED',
      feature: 'coupons',
    });
    const { apiGet } = await loadApi();
    await apiGet('/api/v1/stores/s1/coupons');
    expect(upsells).toHaveLength(0);
  });
});
