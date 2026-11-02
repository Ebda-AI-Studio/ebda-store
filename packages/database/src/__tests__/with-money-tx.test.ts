import { describe, it, expect, vi } from 'vitest';
import { withMoneyTx } from '../with-money-tx';
import { afterTxCommit } from '../tx-hooks';

describe('withMoneyTx', () => {
  it('passes maxWait:10000 and timeout:30000 to prisma.$transaction', async () => {
    const $transaction = vi.fn().mockResolvedValue('ok');
    const fakePrisma = { $transaction } as never;
    const fn = async (_tx: unknown) => 'ok';
    const result = await withMoneyTx(fakePrisma, fn as never);
    expect(result).toBe('ok');
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10000,
      timeout: 30000,
    });
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

  describe('after-commit hooks bound to THIS transaction (Ruling NZ-D19)', () => {
    /** A fake Prisma whose $transaction runs the callback with a fresh tx object and commits unless it throws. */
    const fake = () =>
      ({ $transaction: async (cb: (tx: object) => unknown) => cb({ id: Math.random() }) }) as never;

    it('a hook registered on the tx fires only AFTER that transaction commits', async () => {
      const order: string[] = [];
      await withMoneyTx(fake(), (async (tx: object) => {
        expect(afterTxCommit(tx, () => order.push('hook'))).toBe(true);
        order.push('body');
      }) as never);
      expect(order).toEqual(['body', 'hook']);
    });
    it('a transaction that ROLLS BACK drops its hooks', async () => {
      const hook = vi.fn();
      await expect(
        withMoneyTx(fake(), (async (tx: object) => {
          afterTxCommit(tx, hook);
          throw new Error('rolled back');
        }) as never)
      ).rejects.toThrow('rolled back');
      expect(hook).not.toHaveBeenCalled();
    });
    it('an inner money tx that rolls back never fires while the OUTER tx commits (each tx owns its own hooks)', async () => {
      const outerHook = vi.fn();
      const innerHook = vi.fn();
      await withMoneyTx(fake(), (async (outer: object) => {
        afterTxCommit(outer, outerHook);
        await expect(
          withMoneyTx(fake(), (async (inner: object) => {
            afterTxCommit(inner, innerHook);
            throw new Error('inner rolled back');
          }) as never)
        ).rejects.toThrow('inner rolled back');
      }) as never);
      expect(outerHook).toHaveBeenCalledTimes(1);
      expect(innerHook).not.toHaveBeenCalled();
    });
    it('a transaction object with no registry refuses the hook', () => {
      expect(afterTxCommit({}, () => undefined)).toBe(false);
    });
  });
});
