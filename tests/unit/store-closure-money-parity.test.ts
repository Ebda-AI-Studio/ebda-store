/**
 * M3 of the #772 re-review: the Postgres money-in-flight check must count what the Durable Object check counts
 * (packages/repo/src/do/closure.ts): customer wallets holding a balance and unsettled affiliate payouts. Without them the owner
 * self-delete (and the super_admin delete) erased money the store still owes.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/platform/billing-d1', () => ({ onD1: vi.fn() }));

import { moneyInFlight, assertNoMoneyInFlight } from '@api/services/store-closure.service';

function txReturning(row: Record<string, bigint>) {
  const sql: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      sql.push(strings.join('?'));
      return [row];
    },
  };
  return { tx: tx as never, sql };
}
const zero = {
  paid_undelivered: 0n,
  awaiting: 0n,
  open_returns: 0n,
  cod_outstanding: 0n,
  disputed: 0n,
  payouts: 0n,
  wallets: 0n,
};

describe('moneyInFlight (Postgres) parity with the Durable Object check', () => {
  it('reads customer_wallets (balance > 0) and affiliate_payouts (pending / processing)', async () => {
    const { tx, sql } = txReturning(zero);
    await moneyInFlight(tx, 's1');
    expect(sql[0]).toMatch(/customer_wallets[\s\S]*balance > 0/);
    expect(sql[0]).toMatch(/affiliate_payouts[\s\S]*'pending', 'processing'/);
  });

  it('reports both counts and the delete guard refuses on them', async () => {
    const { tx } = txReturning({ ...zero, payouts: 2n, wallets: 3n });
    expect(await moneyInFlight(tx, 's1')).toMatchObject({ unsettledPayouts: 2, walletBalances: 3 });
    await expect(assertNoMoneyInFlight(tx, 's1')).rejects.toMatchObject({
      code: 'STORE_HAS_MONEY_IN_FLIGHT',
    });
    const { tx: clean } = txReturning(zero);
    await expect(assertNoMoneyInFlight(clean, 's1')).resolves.toBeUndefined();
  });
});
