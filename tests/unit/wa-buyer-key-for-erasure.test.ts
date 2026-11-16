import { afterEach, describe, expect, it } from 'vitest';
import { buyerKeyForErasure } from '@api/lib/wa/buyer-key';

const SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
afterEach(() => {
  delete process.env.SUITE_BUYER_KEY_SECRET;
});

describe('buyerKeyForErasure (an erase must never fail because WhatsApp is not configured)', () => {
  it('hashes the phone before the scrub removes it', async () => {
    process.env.SUITE_BUYER_KEY_SECRET = SECRET;
    expect(await buyerKeyForErasure('01001234567')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('no phone, a junk phone or no secret: undefined, never a throw', async () => {
    process.env.SUITE_BUYER_KEY_SECRET = SECRET;
    expect(await buyerKeyForErasure(null)).toBeUndefined();
    expect(await buyerKeyForErasure('not a phone')).toBeUndefined();
    delete process.env.SUITE_BUYER_KEY_SECRET;
    expect(await buyerKeyForErasure('01001234567')).toBeUndefined();
  });
  it('a secret that is set but shorter than 32 chars THROWS (WA-4): the erasure must not silently skip Chat', async () => {
    process.env.SUITE_BUYER_KEY_SECRET = 'short';
    await expect(buyerKeyForErasure('01001234567')).rejects.toThrow(/SUITE_BUYER_KEY_SECRET/);
    // no phone: nothing to key, so nothing to refuse
    expect(await buyerKeyForErasure(null)).toBeUndefined();
  });
});
