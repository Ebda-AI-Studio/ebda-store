/**
 * CI-1 on real workerd: the five outcomes of an order's life go through the real sink into a real R2
 * bucket (CompressionStream, conditional puts) and an Analytics Engine stand-in, are read back, replayed
 * to one row, and then erased with the real G10 surface. Acceptance 1.8: "place an order, book, deliver
 * and return ... read the events back from the R2 batch and the AE stub; replay the same eventId and
 * see one row".
 */
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';

vi.mock('../src/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));

import { handleCiEventsBatch, ciBuyerIndexKey } from '../src/lib/ci/sink';
import { buildEnvelope } from '../src/lib/ci/port';
import type { CiOutcomeInput } from '../src/lib/ci/envelope';
import { ciSurface, gunzipText, type R2BucketLike } from '../src/cf/erasure';
import { buyerKeyFor } from '@ebda/shared';

const e = env as unknown as { CI_BUCKET: R2Bucket; KV_CACHE: KVNamespace };
const STORE = '3f6f0a52-6b0a-4c55-8e38-2b2b6b1c8a10';
const ORDER = '0d8ea0f4-5a47-4c7d-9a49-6ff3d3b8f6aa';
const SECRET = 'w'.repeat(40); // built at runtime: a literal looks like a key to gitleaks
const at = (s: string) => new Date(`2026-11-03T${s}Z`);

const msg = (body: unknown, id: string) => {
  const acked: string[] = [];
  return {
    id,
    body,
    attempts: 1,
    ack: () => acked.push(id),
    retry: () => acked.push(`retry:${id}`),
    acked,
  };
};

describe('CI capture on workerd', () => {
  it('captures an order life, replays to one row, and erases by buyer key', async () => {
    const buyerKey = (await buyerKeyFor(SECRET, '01001234567'))!;
    const base = { storeId: STORE, orderId: ORDER, buyerKey, xstore: true };
    const inputs: CiOutcomeInput[] = [
      {
        ...base,
        type: 'order.placed',
        seed: `order:${ORDER}`,
        occurredAt: at('10:00:00'),
        data: {
          totalMinor: 150000,
          currency: 'EGP',
          paymentMethod: 'cod',
          channel: 'web',
          itemCount: 2,
          areaKey: 'EG-C-nasr-city',
          isFirstOrderForBuyerInStore: true,
        },
      },
      {
        ...base,
        type: 'shipment.created',
        seed: 'shipment:S',
        occurredAt: at('11:00:00'),
        data: {
          carrier: 'bosta',
          codMinor: 150000,
          areaKey: 'EG-C-nasr-city',
          weightGrams: 500,
          attemptsToBook: 1,
        },
      },
      {
        ...base,
        type: 'shipment.picked_up',
        seed: 'shipment:S:picked_up',
        occurredAt: at('13:00:00'),
        data: { carrier: 'bosta', hoursSinceCreated: 2 },
      },
      {
        ...base,
        type: 'shipment.attempted',
        seed: 'shipment:S:attempt:1',
        occurredAt: at('16:00:00'),
        data: { carrier: 'bosta', attemptNo: 1, reasonCode: 'customer_unreachable' },
      },
      {
        ...base,
        type: 'shipment.returned',
        seed: 'shipment:S:returned',
        occurredAt: at('22:00:00'),
        data: {
          carrier: 'bosta',
          codMinor: 150000,
          returnReasonCode: 'customer_refused',
          returnReasonRaw: 'Consignee refused',
          attempts: 1,
          hoursSincePickup: 9,
        },
      },
    ];
    const envelopes = await Promise.all(inputs.map(i => buildEnvelope(i)));
    const points: unknown[] = [];
    const bindings = {
      CI_BUCKET: e.CI_BUCKET as never,
      KV_CACHE: e.KV_CACHE as never,
      CI_OUTCOMES: { writeDataPoint: (p: unknown) => points.push(p) },
    };

    const first = envelopes.map(x => msg(x, x.eventId));
    await handleCiEventsBatch({ queue: 'ebda-ci-events', messages: first }, bindings);
    expect(first.every(m => m.acked[0] === m.id)).toBe(true);
    expect(points).toHaveLength(5);
    expect(JSON.stringify(points)).not.toContain(buyerKey);
    expect(JSON.stringify(points)).not.toContain(ORDER);

    const list = await e.CI_BUCKET.list({ prefix: `outcomes/v1/store=${STORE}/` });
    expect(list.objects).toHaveLength(1);
    const obj = (await e.CI_BUCKET.get(list.objects[0]!.key))!;
    const lines = (await gunzipText(await obj.arrayBuffer()))
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(lines.map(l => l.type).sort()).toEqual([
      'order.placed',
      'shipment.attempted',
      'shipment.created',
      'shipment.picked_up',
      'shipment.returned',
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/01001234567|\+20100/); // no phone anywhere in R2
    expect(
      JSON.parse(await (await e.CI_BUCKET.get(ciBuyerIndexKey(buyerKey)))!.text()).partitions
    ).toEqual([list.objects[0]!.key]);

    // replay of the very same events (queue redelivery): still ONE row each, no second object, no second AE point
    const again = envelopes.map(x => msg(x, x.eventId));
    await handleCiEventsBatch({ queue: 'ebda-ci-events', messages: again }, bindings);
    expect(
      (await e.CI_BUCKET.list({ prefix: `outcomes/v1/store=${STORE}/` })).objects
    ).toHaveLength(1);
    expect(points).toHaveLength(5);
    expect(again.every(m => m.acked[0] === m.id)).toBe(true);

    // PDPL: erase the buyer through the real surface and verify on the real bucket
    const res = await ciSurface(e.CI_BUCKET as unknown as R2BucketLike).eraseSubject({
      kind: 'customer',
      requestId: 'r',
      buyerKey,
    });
    expect(res).toMatchObject({ erased: 5, remaining: 0 });
    expect(await e.CI_BUCKET.get(ciBuyerIndexKey(buyerKey))).toBeNull();
    expect((await e.CI_BUCKET.list({ prefix: 'outcomes/' })).objects).toHaveLength(0);
  });
});
