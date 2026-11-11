/**
 * Chat -> Store bridge hardening (audit WA-1..WA-4, live-state-beats-token-claims, foundation PR #28):
 * a claim the caller sends (buyerKey, a signed URL) is checked against state the Store holds, never trusted.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../apps/api/src/lib/derived-secret', () => ({
  derivedSecret: () => Buffer.alloc(32, 7),
}));
vi.mock('../../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { createBridge } from '../../../apps/api/src/lib/wa/bridge/service';
import {
  signCheckoutToken,
  verifyCheckoutToken,
  storeBuyerId,
} from '../../../apps/api/src/lib/wa/bridge/checkout-token';
import { proofRef } from '../../../apps/api/src/lib/wa/bridge/proof-ref';
import { buyerKeyForErasure } from '../../../apps/api/src/lib/wa/buyer-key';
import { assertWhatsAppLinkConfig } from '../../../apps/api/src/lib/wa/config';
import { makeFakePort, S, BK, BK_OTHER, BUYER } from './fake-port';

// The secret behind the pinned vector key BK (tests/vectors/ebda-wa/buyer-key.json).
const SECRET = 'ebda-suite-buyer-key-test-v1';
const mk = (secret: () => string = () => SECRET) => {
  const fake = makeFakePort();
  const b = createBridge({
    port: fake.port,
    storefrontUrl: async () => 'https://dar-mona.ebda.app',
    buyerKeySecret: secret,
  });
  return { b, fake };
};
const items = [{ variantId: 'v1', quantity: 1 }];
const forged = { ...BUYER, buyerKey: BK_OTHER }; // a real key, but not this phone's
const otherPhone = { ...BUYER, phoneE164: '+201111111111' }; // this phone's key paired with a different phone

afterEach(() => {
  delete process.env.SUITE_BUYER_KEY_SECRET;
});

describe('WA-2: buyerKey must equal HMAC(secret, phoneE164)', () => {
  it('createCheckoutLink refuses a mismatched or foreign pair and mints no link', async () => {
    const { b } = mk();
    for (const buyer of [forged, otherPhone]) {
      expect(await b.createCheckoutLink(S, { items, buyer })).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(await b.createCheckoutLink(S, { items, buyer: BUYER })).toMatchObject({ ok: true });
  });
  it('createOrderFromChat refuses a mismatched pair and places NO order', async () => {
    const { b, fake } = mk();
    const req = (buyer: typeof BUYER) => ({
      items,
      buyer,
      address: { area: 'Maadi', street: '9 Road 233' },
      paymentMethod: 'cod',
      idempotencyKey: 'idem-key-0001',
    });
    for (const buyer of [forged, otherPhone])
      expect(await b.createOrderFromChat(S, req(buyer))).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    expect(fake.orders.size).toBe(0);
    expect(await b.createOrderFromChat(S, req(BUYER))).toMatchObject({ ok: true });
    expect(fake.orders.size).toBe(1);
  });
  it('fails closed when the secret is missing or short: throws, trusts nothing', async () => {
    const bad = mk(() => {
      throw new Error('SUITE_BUYER_KEY_SECRET must be set');
    });
    await expect(bad.b.createCheckoutLink(S, { items, buyer: BUYER })).rejects.toThrow(
      /SUITE_BUYER_KEY_SECRET/
    );
    const empty = mk(() => '');
    await expect(empty.b.createCheckoutLink(S, { items, buyer: BUYER })).rejects.toThrow();
  });
});

describe('WA-3: the suite buyer key never travels in the checkout URL', () => {
  it('the token carries a per-store id, not the suite key, and differs per store', async () => {
    const { b } = mk();
    const r = (await b.createCheckoutLink(S, { items, buyer: BUYER })) as {
      value: { checkoutUrl: string };
    };
    const token = new URL(r.value.checkoutUrl).searchParams.get('t')!;
    const body = Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8');
    expect(body).not.toContain(BK);
    expect(body).not.toContain('buyerKey');
    expect(verifyCheckoutToken(token)).toMatchObject({ bk: storeBuyerId(S, BK) });
    expect(storeBuyerId(S, BK)).not.toBe(storeBuyerId('22222222-2222-4222-8222-222222222222', BK));
    expect(storeBuyerId(S, BK)).not.toContain(BK.slice(0, 16));
  });
  it('an in-flight token minted before WA-3 (raw buyerKey) still verifies', () => {
    const old = signCheckoutToken({ storeId: S, items, buyerKey: BK } as never, 1_000);
    expect(verifyCheckoutToken(old, 2_000)).toMatchObject({ storeId: S, items });
  });
});

describe('WA-1: a signed proof URL is never stored', () => {
  it('keeps origin + path only, drops the signature and fragment', () => {
    const ref = proofRef('https://chat.ebda.app/media/abc123?sig=SECRETSIG&exp=999#frag');
    expect(ref).toBe('https://chat.ebda.app/media/abc123');
    expect(ref).not.toMatch(/sig|SECRETSIG|exp=|frag/);
    expect(proofRef('https://u:p@chat.ebda.app/m/1?sig=x')).not.toMatch(/u:p|sig/);
    expect(proofRef('not a url')).toBe('invalid-url');
  });
});

describe('WA-4: a broken secret is loud, never a silent skip', () => {
  it('erasure throws for a short secret (unset stays a no-op)', async () => {
    process.env.SUITE_BUYER_KEY_SECRET = 'short';
    await expect(buyerKeyForErasure('01001234567')).rejects.toThrow(/SUITE_BUYER_KEY_SECRET/);
    delete process.env.SUITE_BUYER_KEY_SECRET;
    expect(await buyerKeyForErasure('01001234567')).toBeUndefined();
  });
  it('boot guard rejects a set-but-short secret even with no WhatsApp queue bound', () => {
    process.env.SUITE_BUYER_KEY_SECRET = 'short';
    expect(() => assertWhatsAppLinkConfig({})).toThrow(/SUITE_BUYER_KEY_SECRET/);
    delete process.env.SUITE_BUYER_KEY_SECRET;
    expect(() => assertWhatsAppLinkConfig({})).not.toThrow();
  });
});
