/**
 * G54 (INSTAPAY-UPLOAD-1 part b): a page opened from the signed order-status link sends it as X-Order-Status-Link on
 * THAT order's InstaPay calls only, and never when the tab holds the order's view token.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { rememberOrderStatusLink, rememberOrderViewToken } from './order-view-token';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const storage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
};

const sent = () => {
  const session = storage();
  const local = storage();
  vi.stubGlobal('window', { sessionStorage: session, localStorage: local });
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  const calls: Array<Record<string, string>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      calls.push({ ...(init.headers ?? {}) });
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    })
  );
  return calls;
};

afterEach(() => vi.unstubAllGlobals());

describe('X-Order-Status-Link', () => {
  it("goes on the remembered order's InstaPay calls, not on another order or another endpoint", async () => {
    const calls = sent();
    rememberOrderStatusLink(A, 'store.order.1.sig');
    await api.get(`/payments/instapay/${A}`);
    await api.get(`/payments/instapay/${B}`);
    await api.get(`/public/orders/${A}`);
    expect(calls[0]['X-Order-Status-Link']).toBe('store.order.1.sig');
    expect(calls[1]['X-Order-Status-Link']).toBeUndefined();
    expect(calls[2]['X-Order-Status-Link']).toBeUndefined();
  });
  it('is not sent when the tab holds the view token (the stronger credential is used alone)', async () => {
    const calls = sent();
    rememberOrderStatusLink(A, 'store.order.1.sig');
    rememberOrderViewToken(A, 'view-token');
    await api.get(`/payments/instapay/${A}`);
    expect(calls[0]['X-Order-View-Token']).toBe('view-token');
    expect(calls[0]['X-Order-Status-Link']).toBeUndefined();
  });
});
