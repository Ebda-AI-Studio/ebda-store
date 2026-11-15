/**
 * STORE-EDGE-4 follow-up (review): purges are DURABLE and bundle sale windows purge on the clock.
 *  1. A purge that fails in the request is queued, retried by the job layer, and lands.
 *  2. A purge that never lands dead-letters into the P1 alert (reportJobFailure), not into silence.
 *  3. A bundle ending at T: the scheduled workflow purges at T (fake timers), and the edge copy is capped at T even if
 *     that job never runs (boundary marker).
 * Timed prices in cached pages: only bundle sale windows. Coupons and promotions are cart/checkout only; products have no
 * scheduled price (no start/end columns); gold-rate price changes are writes (purgeGoldPrices).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';

const sendAlert = vi.hoisted(() => vi.fn(async () => 'sent'));
vi.mock('@api/services/alerts.service', () => ({ sendAlert }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(() => 'e'),
  flush: async () => true,
}));
const boundaryRows = vi.hoisted(() => ({
  rows: [] as Array<{ startsAt: Date | null; expiresAt: Date | null }>,
}));
vi.mock('@api/lib/jobs/store-db', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/jobs/store-db')>()),
  withStoreDb: async (_id: string, fn: (db: unknown) => unknown) =>
    fn({ bundle: { findMany: async () => boundaryRows.rows } }),
}));

import { inngest } from '@api/lib/inngest/client';
import { revalidateStorefrontWithRetry } from '@api/lib/revalidate-storefront';
import { handleJobsBatch, type QueueMessageLike } from '@api/lib/jobs/run-queue';
import { getJob } from '@api/lib/jobs/registry';
import '@api/lib/inngest/functions/index';
import { BOUNDARY_SETTLE_MS, runBundleBoundary } from '@api/lib/inngest/functions/storefront-purge';
import {
  BUNDLE_BOUNDARY_EVENT,
  PURGE_RETRY_EVENT,
  bundleBoundaryTag,
  nextBundleBoundary,
} from '@api/lib/storefront-purge-jobs';
import {
  bumpEpochs,
  resetEpochMemo,
  serveStoreEdge,
  parseAllowlist,
} from '../../apps/web/store-edge-cache';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const env = { ...process.env };
const fetchMock = vi.fn();
const res = (s: number) => new Response('{}', { status: s });
let sent: Array<{ name: string; data: Record<string, unknown> }>;

beforeEach(() => {
  process.env.REVALIDATE_SECRET = 's';
  process.env.STOREFRONT_REVALIDATE_URL = 'https://web.example';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sent = [];
  vi.spyOn(inngest, 'send').mockImplementation((async (p: never) => {
    sent.push(...([] as never[]).concat(p));
  }) as never);
  setCfBindings({} as never);
  sendAlert.mockClear();
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearCfBindings();
});

const noSleep = async () => undefined;
const msg = (attempts: number, tags = [`products:${ID}`]) => {
  const m = {
    id: `m${attempts}`,
    attempts,
    body: {
      kind: 'job',
      fn: 'storefront-purge-retry',
      event: { name: PURGE_RETRY_EVENT, id: 'e1', data: { tags } },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return m as typeof m & QueueMessageLike;
};
const deliver = (m: QueueMessageLike) => handleJobsBatch({ queue: 'ebda-jobs', messages: [m] });

describe('durable purge', () => {
  it('a purge that lands in the request queues nothing', async () => {
    fetchMock.mockResolvedValue(res(200));
    expect(await revalidateStorefrontWithRetry({ tags: [`products:${ID}`] }, noSleep)).toBe('ok');
    expect(sent).toEqual([]);
  });

  it('fails in the request -> queued -> retried by the job layer -> lands (no alert)', async () => {
    fetchMock.mockResolvedValue(res(500));
    expect(await revalidateStorefrontWithRetry({ tags: [`products:${ID}`] }, noSleep)).toBe(
      'failed'
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe(PURGE_RETRY_EVENT);
    expect(sent[0].data.tags).toEqual([`products:${ID}`]);

    // attempt 1: the storefront is still down -> the queue retries it (backoff), nothing is acked or alerted
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(res(502));
    const first = msg(1);
    await deliver(first);
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    // attempt 2: it is back -> the purge POST lands, the message is acked
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(res(200));
    const second = msg(2);
    await deliver(second);
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(second.retry).not.toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.tags).toEqual([`products:${ID}`]);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a config fault (401) is queued too, and a permanent failure dead-letters into the P1 alert', async () => {
    fetchMock.mockResolvedValue(res(401));
    expect(await revalidateStorefrontWithRetry({ tags: [`products:${ID}`] }, noSleep)).toBe(
      'rejected'
    );
    expect(sent.map(s => s.name)).toEqual([PURGE_RETRY_EVENT]);

    const retries = getJob('storefront-purge-retry')!.options.retries!;
    expect(retries).toBeGreaterThanOrEqual(5);
    const last = msg(retries + 1); // retries spent
    await deliver(last);
    expect(last.ack).toHaveBeenCalledTimes(1); // handled: parked in the failure path, not looped forever
    expect(last.retry).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendAlert.mock.calls[0])).toContain('storefront-purge-retry');
  });
});

describe('bundle sale window boundary', () => {
  const T = Date.UTC(2026, 10, 20, 12, 0, 0);

  it('nextBundleBoundary: earliest future start or end of an active bundle, past ones ignored', async () => {
    boundaryRows.rows = [
      { startsAt: new Date(T - 5000), expiresAt: new Date(T + 90_000) },
      { startsAt: new Date(T + 30_000), expiresAt: null },
      { startsAt: null, expiresAt: new Date(T - 1) },
    ];
    expect(await nextBundleBoundary(ID, T)).toBe(T + 30_000);
    boundaryRows.rows = [];
    expect(await nextBundleBoundary(ID, T)).toBeNull();
  });

  it('a bundle ending at T: the workflow sleeps until T, then purges products/categories/bundles and schedules the next boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T - 3_600_000);
    const NEXT = T + 7 * 86_400_000;
    boundaryRows.rows = [{ startsAt: null, expiresAt: new Date(NEXT) }]; // after T only a later bundle remains
    fetchMock.mockImplementation(async () => res(200));
    const events: unknown[] = [];
    const step = {
      sleepUntil: (_id: string, until: number) =>
        new Promise<void>(r => setTimeout(r, Math.max(0, until - Date.now()))),
      run: <X>(_id: string, fn: () => Promise<X>) => fn(),
      sendEvent: async (_id: string, p: unknown) => void events.push(p),
    };
    const done = runBundleBoundary({ storeId: ID, at: T }, step as never);
    await vi.advanceTimersByTimeAsync(3_600_000 - 1_000); // T - 1 s: nothing yet
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000 + BOUNDARY_SETTLE_MS + 10); // T + settle: purge fires
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tags = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).tags as string[];
    expect(tags).toEqual([
      `products:${ID}`,
      `categories:${ID}`,
      `bundles:${ID}`,
      bundleBoundaryTag(ID, NEXT),
    ]);
    expect(events).toEqual([
      { name: BUNDLE_BOUNDARY_EVENT, data: { storeId: ID, at: NEXT, key: `${ID}:${NEXT}` } },
    ]);
  });

  it('the boundary job is a Workflow with an idempotency key, so a repeated schedule is one instance', () => {
    const def = getJob('storefront-bundle-boundary')!;
    expect(def.options.idempotency).toBe('event.data.key');
  });

  it('belt and braces: the edge copy is capped at T even when the scheduled purge never ran', async () => {
    class Cache {
      m = new Map<string, Response>();
      async match(k: string) {
        return this.m.get(k)?.clone();
      }
      async put(k: string, r: Response) {
        this.m.set(k, r);
      }
    }
    class R2 {
      m = new Map<string, string>();
      async get(k: string) {
        const v = this.m.get(k);
        return v === undefined ? null : { text: async () => v };
      }
      async put(k: string, v: string) {
        this.m.set(k, v);
      }
    }
    resetEpochMemo();
    const cache = new Cache();
    const r2 = new R2();
    let clock = T - 3_600_000;
    let renders = 0;
    const waits: Promise<unknown>[] = [];
    const deps = () => ({
      allow: parseAllowlist('shop-a.ebda.app'),
      r2,
      cache,
      build: 'aaaaaaaa-1111-4111-8111-111111111111',
      verdict: async () => ({ ok: true, id: ID }),
      now: () => clock,
    });
    const get = async () => {
      const r = await serveStoreEdge(
        new Request('https://shop-a.ebda.app/bundles', { headers: { accept: 'text/html' } }),
        { waitUntil: (p: Promise<unknown>) => void waits.push(p) },
        async () => {
          renders++;
          return new Response(`render ${renders}`, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        },
        deps()
      );
      await Promise.all(waits.splice(0));
      return { state: r.headers.get('x-store-edge'), body: await r.text() };
    };
    await get(); // rendered at T - 1 h, bundle still on sale
    // bundle created/updated: the API publishes the store's next boundary (T) through the purge channel
    await bumpEpochs(r2, [bundleBoundaryTag(ID, T)], clock);
    clock = T - 60_000;
    expect((await get()).state).toMatch(/HIT|STALE/); // before T the copy is good
    clock = T - 1_000;
    expect((await get()).state).toMatch(/HIT|STALE/);
    clock = T + 1_000; // the sale ended; NO purge ran
    const after = await get();
    expect(after.state).toBe('MISS'); // the copy rendered before T is not served at or after T
    expect(after.body).toContain('render');
    clock = T + 2_000;
    expect((await get()).state).toBe('HIT'); // the page rendered after T is valid again
    // the boundary tag never wipes the store: it is not an epoch purge
    expect([...r2.m.keys()].some(k => k.endsWith(`/all`) || k.endsWith(`id/${ID}`))).toBe(false);
  });
});
