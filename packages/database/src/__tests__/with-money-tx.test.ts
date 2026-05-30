import { describe, it, expect, vi } from 'vitest';
import { withMoneyTx } from '../with-money-tx';

describe('withMoneyTx', () => {
  it('passes maxWait:10000 and timeout:30000 to prisma.$transaction', async () => {
    const $transaction = vi.fn().mockResolvedValue('ok');
    const fakePrisma = { $transaction } as never;
    const fn = async (_tx: unknown) => 'ok';
    const result = await withMoneyTx(fakePrisma, fn as never);
    expect(result).toBe('ok');
    expect($transaction).toHaveBeenCalledWith(fn, { maxWait: 10000, timeout: 30000 });
  });

  it('allows per-call overrides to win', async () => {
    const $transaction = vi.fn().mockResolvedValue(1);
    const fakePrisma = { $transaction } as never;
    await withMoneyTx(fakePrisma, (async () => 1) as never, { timeout: 60000 });
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10000,
      timeout: 60000,
    });
  });
});
