import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// Ruling CF-JOBS-4B: the webhook endpoint cap on real workerd. A Durable Object serves other requests between two awaited calls,
// so "count, then create" as two calls lets concurrent creates pass the cap together. `webhookEndpointCreate` counts and inserts
// in ONE section: N concurrent creates never exceed the cap.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const create = async (stub: ReturnType<typeof stubFor>, store: string, i: number, max: number) =>
  (await stub.moneyOp(
    store,
    'webhookEndpointCreate',
    encodeRpc({
      maxEndpoints: max,
      url: `https://hooks.example.com/${i}`,
      description: null,
      events: ['order.created'],
      includeCustomer: false,
      secretEnc: `enc-${i}`,
      secretHint: 'abcd',
      createdBy: 'u1',
    })
  )) as Answer;
/** The first call binds the DO to its store (as every other workers-do test does). */
const bind = async (stub: ReturnType<typeof stubFor>, store: string) =>
  stub.moneyOp(store, 'cancel', encodeRpc({ orderId: 'nope' }));
const rows = (stub: ReturnType<typeof stubFor>, store: string) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql
        .exec('SELECT COUNT(*) AS n FROM webhook_endpoints WHERE store_id = ?', store)
        .one().n as number
  );

describe('webhook endpoint cap under concurrency', () => {
  it('24 concurrent creates against a cap of 5 admit exactly 5', async () => {
    const store = 'whcap-store-1';
    const stub = stubFor(store);
    await bind(stub, store);
    const answers = await Promise.all(
      Array.from({ length: 24 }, (_, i) => create(stub, store, i, 5))
    );
    const ok = answers.filter(a => a.ok);
    const refused = answers.filter(a => !a.ok) as Array<Extract<Answer, { ok: false }>>;
    expect(ok).toHaveLength(5);
    expect(new Set(refused.map(r => r.code))).toEqual(new Set(['WEBHOOK_LIMIT']));
    expect(await rows(stub, store)).toBe(5);
    expect(
      new Set(ok.map(a => decodeRpc<{ id: string }>((a as { json: string }).json).id)).size
    ).toBe(5);
  });

  it('a second store has its own count', async () => {
    const a = 'whcap-store-2';
    const b = 'whcap-store-3';
    await bind(stubFor(a), a);
    await bind(stubFor(b), b);
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => create(stubFor(a), a, i, 3)),
      ...Array.from({ length: 6 }, (_, i) => create(stubFor(b), b, i, 3)),
    ]);
    expect(await rows(stubFor(a), a)).toBe(3);
    expect(await rows(stubFor(b), b)).toBe(3);
  });
});
