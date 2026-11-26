/** Ruling WA-BRIDGE-BIND-4: the production bridge is strict unless the flag is exactly "0"; committed config sets it to "1". */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buyerProofRequired } from '../../../apps/api/src/lib/wa/bridge/proof-policy';

describe('buyerProofRequired', () => {
  it('unset, empty, "1" and junk are all strict (fail closed)', () => {
    for (const v of [undefined, '', '1', 'true', 'off', ' 0'])
      expect(buyerProofRequired(v)).toBe(true);
  });
  it('only the exact "0" relaxes it', () => {
    expect(buyerProofRequired('0')).toBe(false);
  });
});

describe('production wiring', () => {
  const root = resolve(__dirname, '../../..');
  it('index.ts reads the flag through buyerProofRequired (no === "1" opt-in)', () => {
    const src = readFileSync(resolve(root, 'apps/api/src/lib/wa/bridge/index.ts'), 'utf8');
    expect(src).toContain('buyerProofRequired(process.env.WA_BRIDGE_REQUIRE_BUYER_PROOF)');
    expect(src).not.toMatch(/WA_BRIDGE_REQUIRE_BUYER_PROOF\s*===\s*'1'/);
  });
  it('apps/api/wrangler.jsonc commits WA_BRIDGE_REQUIRE_BUYER_PROOF="1"', () => {
    const src = readFileSync(resolve(root, 'apps/api/wrangler.jsonc'), 'utf8');
    expect(src).toMatch(/^\s*"WA_BRIDGE_REQUIRE_BUYER_PROOF":\s*"1"/m);
  });
});

describe('Chat order lookup under strict mode (flag unset)', () => {
  it('a valid buyer key + phone still reads status and order list; no phone is refused', async () => {
    const { createBridge } = await import('../../../apps/api/src/lib/wa/bridge/service');
    const { makeFakePort, S, BK, BUYER } = await import('./fake-port');
    const b = createBridge({
      port: makeFakePort().port,
      storefrontUrl: async () => 'https://x',
      buyerKeySecret: () => 'ebda-suite-buyer-key-test-v1',
      requireBuyerProof: () => buyerProofRequired(undefined),
    });
    expect(await b.listCustomerOrders(S, BK, 5, BUYER.phoneE164)).toMatchObject({ ok: true });
    expect(await b.listCustomerOrders(S, BK, 5)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
