/**
 * TEN-7 (2026-11-12 audit): a staff member removed from a store must stop receiving that store's realtime
 * events on an already-open socket. Membership is re-checked before delivery once the last check is stale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const fetchMock = vi.fn();
vi.mock('../../apps/api/src/lib/fetch-timeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchMock(...a),
}));

import { StoreRealtime, REVERIFY_MS } from '../../apps/api/src/cf/store-realtime';

function makeWs(att: Record<string, unknown>) {
  let a = att;
  return {
    sent: [] as string[],
    send(m: string) {
      this.sent.push(m);
    },
    serializeAttachment(v: Record<string, unknown>) {
      a = v;
    },
    deserializeAttachment: () => a,
  };
}

function makeDo(ws: ReturnType<typeof makeWs>) {
  const removed: string[] = [];
  const env = {
    API_URL: 'https://api.test',
    STORE_REALTIME: {
      idFromName: (n: string) => n,
      get: () => ({ removeSubscriber: async (u: string) => void removed.push(u) }),
    },
  };
  const ctx = { getWebSockets: () => [ws] };
  const d = new (StoreRealtime as unknown as new (c: unknown, e: unknown) => StoreRealtime)(
    ctx,
    env
  );
  return { d, removed };
}

describe('StoreRealtime.deliver membership re-check (TEN-7)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const base = (checkedAgo: number) => ({
    sid: 's',
    expectUser: 'u1',
    userId: 'u1',
    role: 'store_admin',
    token: 't',
    subs: ['store-A'],
    checked: { 'store-A': Date.now() - checkedAgo },
  });

  it('does not call the API while the last check is fresh', async () => {
    const ws = makeWs(base(1000));
    const { d } = makeDo(ws);
    expect(await d.deliver({ event: 'order', payload: {}, storeId: 'store-A' })).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivers after a stale check that still passes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const ws = makeWs(base(REVERIFY_MS + 1));
    const { d } = makeDo(ws);
    expect(await d.deliver({ event: 'order', payload: {}, storeId: 'store-A' })).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops the room and withholds the event when staff were removed (403)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const ws = makeWs(base(REVERIFY_MS + 1));
    const { d, removed } = makeDo(ws);
    expect(await d.deliver({ event: 'order', payload: { secret: 1 }, storeId: 'store-A' })).toBe(0);
    expect(ws.sent.some(m => m.includes('secret'))).toBe(false);
    expect((ws.deserializeAttachment() as { subs: string[] }).subs).toEqual([]);
    expect(removed).toEqual(['u1']);
    // and stays dropped
    expect(await d.deliver({ event: 'order', payload: {}, storeId: 'store-A' })).toBe(0);
  });

  it('withholds but keeps the subscription on a transport failure', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const ws = makeWs(base(REVERIFY_MS + 1));
    const { d } = makeDo(ws);
    expect(await d.deliver({ event: 'order', payload: {}, storeId: 'store-A' })).toBe(0);
    expect((ws.deserializeAttachment() as { subs: string[] }).subs).toEqual(['store-A']);
  });
});
