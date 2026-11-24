/**
 * A freeze guards writes against a move snapshot: inside a sweep scope it must still be a FRESH read. A freeze set after a first
 * guard call is seen on the very next one; only `readCutoverKeysMany` (route markers) may use the 10 s scope memo.
 */
import { describe, expect, it, vi } from 'vitest';

const rows: Array<{ key: string; value: string }> = [];
let reads = 0;
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => ({
    PLATFORM_DB: {
      prepare: () => ({
        bind: (...keys: string[]) => ({
          all: async () => {
            reads++;
            return { results: rows.filter(r => keys.includes(r.key)) };
          },
        }),
      }),
    },
  }),
}));

import { isFamilyFrozen, assertNotFrozen } from '@api/services/platform/cutover';
import { withSweepScope } from '@api/lib/sweep-scope';

describe('freeze guards are always a fresh read inside a sweep scope', () => {
  it('a freeze set after the first guard call is seen on the next call in the same scope', async () => {
    rows.length = 0;
    await withSweepScope(async () => {
      expect(await isFamilyFrozen('billing')).toBe(false);
      rows.push({ key: 'platform_freeze.billing', value: '{}' });
      expect(await isFamilyFrozen('billing')).toBe(true);
      await expect(assertNotFrozen('billing')).rejects.toMatchObject({
        code: 'PLATFORM_FAMILY_FROZEN',
      });
    });
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});
