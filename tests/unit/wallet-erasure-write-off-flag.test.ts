/**
 * Issue 2126: the admin wallet history flags exactly the entry erasure wrote
 * (type `expire` + the erasure note), so the merchant sees a narrow line for
 * it. Mutation-proof: flagging every `expire` (or none) reddens this.
 */
import { describe, it, expect, vi } from 'vitest';

const findMany = vi.fn();
vi.mock('@force/database', () => ({
  prisma: { walletTransaction: { findMany: (...a: unknown[]) => findMany(...a) } },
  Prisma: {},
}));

import { WalletService, isErasureWriteOff } from '@api/services/wallet.service';

describe('wallet history erasure write-off flag (issue 2126)', () => {
  it('flags only the erasure forfeit entry', async () => {
    findMany.mockResolvedValue([
      { id: 'a', type: 'expire', note: 'Forfeited on account erasure' },
      { id: 'b', type: 'expire', note: null },
      { id: 'c', type: 'admin_adjust', note: 'Forfeited on account erasure' },
    ]);
    const page = await WalletService.listTransactions('s1', 'c1');
    expect(page.transactions.map(t => [t.id, t.erasureWriteOff])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
    expect(isErasureWriteOff({ type: 'expire', note: 'x' })).toBe(false);
  });
});
