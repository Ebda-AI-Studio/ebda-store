/**
 * INSTAPAY-AUTO-1 R1: one receipt (same reference + image) submitted by Store AND Chat at the same instant, 20 times in parallel across both:
 * exactly ONE winner overall, every loser is a duplicate. Runs the real foundation index on the production dedupe SQL; Chat is a second consumer
 * of the same database with product 'chat' (the Chat repo runs the same contract against its own binding). Also the env-drift gate's verdicts.
 */
import { describe, expect, it } from 'vitest';
import { D1DuplicateIndex } from '@ebda/shared';
import { buildWorld, d1Over } from '../helpers/instapay-auto-world';
// @ts-expect-error plain .mjs script, no types
import { verdictFor } from '../../scripts/instapay-auto-rollout-check.mjs';

const REF = '123456789012';
const SHA = '9'.repeat(64);

describe('R1 cross-product dedupe', () => {
  it('20 parallel claims of one receipt across both products: exactly one winner, every loser a duplicate', async () => {
    const w = buildWorld();
    const store = new D1DuplicateIndex(d1Over(w.dd) as never);
    const chat = new D1DuplicateIndex(d1Over(w.dd) as never);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? store : chat).claim({
          referenceKey: REF,
          imageSha256: SHA,
          product: i % 2 === 0 ? 'store' : 'chat',
          ownerId: `owner-${i}`,
          paymentId: `pay-${i}`,
        })
      )
    );
    expect(results.filter(r => r === 'claimed')).toHaveLength(1);
    expect(
      results.filter(r => r === 'duplicate_reference' || r === 'duplicate_image')
    ).toHaveLength(19);
    expect(w.dd.prepare('SELECT COUNT(*) n FROM instapay_dedupe').get()).toEqual({ n: 2 }); // no orphan half-claims
  });

  it('a Chat-held receipt is refused to Store and vice versa', async () => {
    const w = buildWorld();
    const idx = new D1DuplicateIndex(d1Over(w.dd) as never);
    expect(
      await idx.claim({
        referenceKey: REF,
        imageSha256: SHA,
        product: 'chat',
        ownerId: 'ws',
        paymentId: 'r1',
      })
    ).toBe('claimed');
    expect(
      await idx.claim({
        referenceKey: REF,
        imageSha256: 'a'.repeat(64),
        product: 'store',
        ownerId: 's',
        paymentId: 'p1',
      })
    ).toBe('duplicate_reference');
    expect(
      await idx.claim({
        referenceKey: '999999999999',
        imageSha256: SHA,
        product: 'store',
        ownerId: 's',
        paymentId: 'p2',
      })
    ).toBe('duplicate_image');
  });
});

describe('R1 env-drift gate', () => {
  it('ready only when instapayAuto.ready is true; otherwise it names what is missing', () => {
    expect(verdictFor('store', { instapayAuto: { ready: true, missing: [] } }).ok).toBe(true);
    expect(
      verdictFor('chat', { instapayAuto: { ready: false, missing: ['INSTAPAY_DEDUPE_DB'] } })
    ).toMatchObject({ ok: false, why: expect.stringContaining('INSTAPAY_DEDUPE_DB') });
    expect(verdictFor('brain', {}).ok).toBe(false);
    expect(verdictFor('store', null).ok).toBe(false);
  });
});
