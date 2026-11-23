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
