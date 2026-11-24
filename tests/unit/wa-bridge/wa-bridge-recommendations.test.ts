/**
 * Chat product recommendations over the bridge (register: "Product recommendations in the Chat agent").
 * Service layer (fake port): argument edge, buyer proof for the after-order path. Records the vector replayed by ebda-whatsapp.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../../../apps/api/src/lib/derived-secret', () => ({
  derivedSecret: () => Buffer.alloc(32, 7),
}));

import { createBridge } from '../../../apps/api/src/lib/wa/bridge/service';
import { makeFakePort, S, S_UNLINKED, S_UNKNOWN, BK, BK_OTHER, BUYER } from './fake-port';

const SECRET = 'ebda-suite-buyer-key-test-v1';
const mk = () => {
  const fake = makeFakePort();
  const b = createBridge({
    port: fake.port,
    storefrontUrl: async () => 'https://dar-mona.ebda.app',
    buyerKeySecret: () => SECRET,
  });
  return { b, fake };
};
const FIXTURE = path.resolve(__dirname, '../../vectors/ebda-wa/bridge-recs-v1.json');
const SUMS = path.resolve(__dirname, '../../vectors/ebda-wa/SHA256SUMS');

const CASES: Array<{ name: string; args: unknown[] }> = [
  {
    name: 'similar to one seed, in stock only',
    args: [S, { seedIds: ['v1'], mode: 'similar', limit: 5 }],
  },
  {
    name: 'budget caps the price',
    args: [S, { seedIds: ['v1'], mode: 'complement', limit: 5, maxPriceMinor: 30000 }],
  },
  {
    name: 'no seeds and no order is invalid',
    args: [S, { seedIds: [], mode: 'similar', limit: 5 }],
  },
  { name: 'limit over 8 is invalid', args: [S, { seedIds: ['v1'], mode: 'similar', limit: 9 }] },
  {
    name: 'unlinked store is not_linked',
    args: [S_UNLINKED, { seedIds: ['v1'], mode: 'similar', limit: 3 }],
  },
  {
    name: 'unknown store is not_found',
    args: [S_UNKNOWN, { seedIds: ['v1'], mode: 'similar', limit: 3 }],
  },
];

describe('getRecommendations', () => {
  it('returns only in-stock rows, never the seed (Franco/Arabic shopper: "عايز حاجة شبه دي")', async () => {
    const { b } = mk();
    const r = await b.getRecommendations(S, { seedIds: ['v1'], mode: 'similar', limit: 5 });
    expect(r).toMatchObject({ ok: true });
    const ids = (r as any).value.items.map((x: any) => x.retailerId);
    expect(ids).toEqual(['v2']); // v3 is out of stock, v1 is the seed
  });
  it('budget (tahet 300 geneh) filters by minor units', async () => {
    const { b } = mk();
    const r: any = await b.getRecommendations(S, {
      seedIds: ['v2'],
      mode: 'complement',
      limit: 5,
      maxPriceMinor: 30000,
    });
    expect(r.value.items.map((x: any) => x.retailerId)).toEqual(['v1']);
  });
  it('rejects empty seeds without an order, and a limit over 8', async () => {
    const { b } = mk();
    expect(await b.getRecommendations(S, { seedIds: [], mode: 'similar', limit: 3 })).toMatchObject(
      { ok: false, reason: 'invalid' }
    );
    expect(
      await b.getRecommendations(S, { seedIds: ['v1'], mode: 'similar', limit: 9 })
    ).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('an unresolved or unlinked store is refused, never defaulted', async () => {
    const { b } = mk();
    expect(
      await b.getRecommendations(S_UNKNOWN, { seedIds: ['v1'], mode: 'similar', limit: 3 })
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(
      await b.getRecommendations(S_UNLINKED, { seedIds: ['v1'], mode: 'similar', limit: 3 })
    ).toMatchObject({ ok: false, reason: 'not_linked' });
  });
  it("after-order: seeds come from the buyer's own order; a forged key or other buyer gets nothing", async () => {
    const { b } = mk();
    const placed: any = await b.createOrderFromChat(S, {
      items: [{ variantId: 'v1', quantity: 1 }],
      buyer: BUYER,
      addressId: 'a1',
      paymentMethod: 'cod',
      idempotencyKey: 'idem-recs-0001',
    });
    const num = placed.value.orderNumber;
    const own: any = await b.getRecommendations(S, {
      seedIds: [],
      orderNumber: num,
      buyerKey: BK,
      phoneE164: BUYER.phoneE164,
      mode: 'complement',
      limit: 3,
    });
    expect(own.ok).toBe(true);
    expect(own.value.items.length).toBeGreaterThan(0);
    // a real key that is not this phone's
    expect(
      await b.getRecommendations(S, {
        seedIds: [],
        orderNumber: num,
        buyerKey: BK_OTHER,
        phoneE164: BUYER.phoneE164,
        mode: 'complement',
        limit: 3,
      })
    ).toMatchObject({ ok: false, reason: 'invalid' });
    // right key shape, but the order belongs to someone else: answers like an unknown order
    expect(
      await b.getRecommendations(S, {
        seedIds: [],
        orderNumber: num,
        buyerKey: 'a'.repeat(64),
        mode: 'complement',
        limit: 3,
      })
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  if (process.env.WA_BRIDGE_REGEN) {
    it('regenerates the fixture', async () => {
      const { b } = mk();
      const cases = [];
      for (const c of CASES)
        cases.push({
          ...c,
          method: 'getRecommendations',
          expect: JSON.parse(JSON.stringify(await (b as any).getRecommendations(...c.args))),
        });
      writeFileSync(FIXTURE, JSON.stringify({ version: 1, cases }, null, 1) + '\n');
    });
    return;
  }
  it('the recorded vector replays and matches its pinned hash', async () => {
    const raw = readFileSync(FIXTURE);
    const sha = createHash('sha256').update(raw).digest('hex');
    expect(readFileSync(SUMS, 'utf8')).toContain(`${sha}  bridge-recs-v1.json`);
    const { b } = mk();
    for (const c of JSON.parse(raw.toString()).cases)
      expect(JSON.parse(JSON.stringify(await (b as any)[c.method](...c.args)))).toEqual(c.expect);
  });
});
