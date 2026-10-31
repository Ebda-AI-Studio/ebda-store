/**
 * Ruling WALLET-GL-1 — every store-credit movement is journaled on 2150
 * "Customer Wallet Liability". Pure unit test: the journal writer is captured,
 * so these pin WHICH lines each movement books (accounts, sides, amounts) and the
 * invariant the whole ruling exists for: 2150 == the sum of wallet balances.
 * The real-Postgres half is tests/integration/accounting/wallet-gl.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Line = { accountId: string; debit: number; credit: number };
type Posted = { source: string; sourceId?: string; lines: Line[] };
const h = vi.hoisted(() => ({ posted: [] as Posted[] }));

vi.mock('@ebda/database', () => ({
  prisma: {},
  currentStoreId: () => 'store-1',
}));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@api/services/accounting/account.service', () => ({
  // The account id IS the code, so assertions read like a ledger.
  getSystemAccountIdByCode: vi.fn(async (_s: string, code: string) => code),
}));
vi.mock('@api/services/accounting/journal.service', () => ({
  postEntry: vi.fn(async (input: Posted) => {
    const dr = input.lines.reduce((s, l) => s + l.debit, 0);
    const cr = input.lines.reduce((s, l) => s + l.credit, 0);
    if (dr !== cr) throw new Error(`Journal lines unbalanced: DR=${dr} CR=${cr}`);
    h.posted.push(input);
    return { id: `je-${h.posted.length}` };
  }),
}));

import { postWalletMovementJournal } from '@api/services/accounting/posting/wallet-posting';
import { postOrderPaymentJournal } from '@api/services/accounting/posting/order-posting';

const txFor = (accountingEnabled: boolean) =>
  ({ store: { findUnique: vi.fn(async () => ({ accountingEnabled })) } }) as any;

const move = (type: string, amount: number, id = `w${h.posted.length + 1}`) => ({
  id,
  storeId: 'store-1',
  type,
  amount,
});

/** Signed balance of one account across the captured journal (credit - debit for a liability). */
const creditBalance = (code: string) =>
  h.posted
    .flatMap(p => p.lines)
    .filter(l => l.accountId === code)
    .reduce((s, l) => s + l.credit - l.debit, 0);

beforeEach(() => {
  h.posted.length = 0;
});

describe('postWalletMovementJournal', () => {
  it('goodwill / admin credit: DR 5950 Customer Goodwill, CR 2150', async () => {
    const r = await postWalletMovementJournal({
      entry: move('admin_adjust', 5000),
      tx: txFor(true),
    });
    expect(r.posted).toBe(true);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0].source).toBe('manual');
    expect(h.posted[0].sourceId).toBe('wallet:w1');
    expect(h.posted[0].lines).toEqual([
      expect.objectContaining({ accountId: '5950', debit: 5000, credit: 0 }),
      expect.objectContaining({ accountId: '2150', debit: 0, credit: 5000 }),
    ]);
  });

  it('reversal of a credit (admin debit): the mirror, DR 2150, CR 5950', async () => {
    await postWalletMovementJournal({ entry: move('admin_adjust', -1200), tx: txFor(true) });
    expect(h.posted[0].lines).toEqual([
      expect.objectContaining({ accountId: '2150', debit: 1200, credit: 0 }),
      expect.objectContaining({ accountId: '5950', debit: 0, credit: 1200 }),
    ]);
  });

  it('forfeit / expiry / erasure write-off: DR 2150, CR 4100 Unused Store Credit', async () => {
    await postWalletMovementJournal({ entry: move('expire', -3300), tx: txFor(true) });
    expect(h.posted[0].lines).toEqual([
      expect.objectContaining({ accountId: '2150', debit: 3300, credit: 0 }),
      expect.objectContaining({ accountId: '4100', debit: 0, credit: 3300 }),
    ]);
  });

  it.each(['refund_credit', 'order_payment', 'order_payment_reversal'])(
    '%s is owned by another posting and is NOT journaled here (no double booking)',
    async type => {
      const r = await postWalletMovementJournal({
        entry: move(type, type === 'order_payment' ? -900 : 900),
        tx: txFor(true),
      });
      expect(r.posted).toBe(false);
      expect(h.posted).toHaveLength(0);
    }
  );

  it('accounting off: nothing is journaled', async () => {
    const r = await postWalletMovementJournal({
      entry: move('admin_adjust', 5000),
      tx: txFor(false),
    });
    expect(r.posted).toBe(false);
    expect(h.posted).toHaveLength(0);
  });
});

function paidOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'EB-1',
    storeId: 'store-1',
    status: 'confirmed',
    paymentStatus: 'paid',
    store: { id: 'store-1', accountingEnabled: true },
    items: [],
    payments: [{ provider: 'paymob', status: 'completed' }],
    appliedPromotion: null,
    couponCode: null,
    taxIncludedInPrice: false,
    subtotal: 8000,
    discount: 0,
    tax: 0,
    shipping: 0,
    total: 8000,
    walletAmount: 0,
    ...over,
  };
}
const orderTx = (order: unknown) => ({ order: { findUnique: vi.fn(async () => order) } }) as any;

describe('postOrderPaymentJournal with wallet redemption (W-3 refusal removed)', () => {
  it('part-wallet order: DR cash for the cash part, DR 2150 for the wallet part, CR revenue for the total', async () => {
    await postOrderPaymentJournal({
      orderId: 'o1',
      tx: orderTx(paidOrder({ walletAmount: 3000 })),
    });
    expect(h.posted).toHaveLength(1);
    const lines = h.posted[0].lines;
    expect(lines).toContainEqual(expect.objectContaining({ accountId: '1000', debit: 5000 }));
    expect(lines).toContainEqual(expect.objectContaining({ accountId: '2150', debit: 3000 }));
    expect(lines).toContainEqual(expect.objectContaining({ accountId: '4000', credit: 8000 }));
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(lines.reduce((s, l) => s + l.credit, 0));
  });

  it('wallet-only order: no zero cash line, the WHOLE order is journaled (DR 2150 = total)', async () => {
    await postOrderPaymentJournal({
      orderId: 'o1',
      tx: orderTx(paidOrder({ walletAmount: 8000, payments: [] })),
    });
    expect(h.posted).toHaveLength(1);
    const lines = h.posted[0].lines;
    expect(lines.some(l => l.accountId === '1020' && l.debit === 0 && l.credit === 0)).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ accountId: '2150', debit: 8000 }));
    expect(lines.some(l => l.accountId.startsWith('10') && l.debit > 0)).toBe(false);
  });

  it('an order with no wallet spend books exactly what it did before', async () => {
    await postOrderPaymentJournal({ orderId: 'o1', tx: orderTx(paidOrder()) });
    const lines = h.posted[0].lines;
    expect(lines).toContainEqual(expect.objectContaining({ accountId: '1000', debit: 8000 }));
    expect(lines.some(l => l.accountId === '2150')).toBe(false);
  });
});

describe('trial balance: 2150 equals the sum of wallet balances', () => {
  it('after issue, redemption, a reversal and a forfeit', async () => {
    const tx = txFor(true);
    const balances = new Map<string, number>([
      ['a', 0],
      ['b', 0],
    ]);
    const credit = async (who: string, amt: number, type = 'admin_adjust') => {
      balances.set(who, balances.get(who)! + amt);
      await postWalletMovementJournal({ entry: move(type, amt), tx });
    };

    await credit('a', 10_000); // goodwill to a
    await credit('b', 4_000); // goodwill to b
    await credit('a', -1_500); // admin reverses part of a's credit

    // a redeems 3 000 of it on an 8 000 order (journaled when the order is paid)
    balances.set('a', balances.get('a')! - 3_000);
    await postOrderPaymentJournal({
      orderId: 'o1',
      tx: orderTx(paidOrder({ walletAmount: 3_000 })),
    });

    // b's remaining balance is written off (erasure)
    const bBal = balances.get('b')!;
    balances.set('b', 0);
    await postWalletMovementJournal({ entry: move('expire', -bBal), tx });

    const walletSum = [...balances.values()].reduce((s, v) => s + v, 0);
    expect(walletSum).toBe(5_500);
    expect(creditBalance('2150')).toBe(walletSum);
    // and the P&L side: goodwill expense nets 12 500, unused-credit income is 4 000
    expect(-creditBalance('5950')).toBe(12_500);
    expect(creditBalance('4100')).toBe(4_000);
  });
});
