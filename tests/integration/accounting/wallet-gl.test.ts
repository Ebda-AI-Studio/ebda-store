/**
 * Ruling WALLET-GL-1 against a REAL Postgres: every store-credit movement is
 * journaled on 2150 "Customer Wallet Liability", and after any mix of them the
 * trial-balance figure for 2150 equals the sum of the customers' wallet balances.
 * Self-skips without a real DATABASE_URL; every fixture id is per call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext, withRlsBypass } from '@ebda/database';

import { seedCoaForStore } from '@api/services/accounting/account.service';
import { postOrderPaymentJournal } from '@api/services/accounting/posting/order-posting';
import { postRefundJournal } from '@api/services/accounting/posting/refund-posting';
import { WalletService } from '@api/services/wallet.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');
const TAG = `wgl-${Date.now().toString(36)}-${process.pid}`;
let seq = 0;
const uid = (label: string) => `${TAG}-${label}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!hasDb)('wallet GL (Ruling WALLET-GL-1)', () => {
  let storeId: string;
  let ownerId: string;
  const inStore = <T>(fn: () => Promise<T>) => runInTenantContext(storeId, fn);

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${uid('owner')}@example.test`,
        passwordHash: 'x',
        firstName: 'O',
        lastName: 'W',
        role: 'store_admin',
      },
    });
    ownerId = owner.id;
    const slug = uid('store');
    const store = await prisma.store.create({
      data: { name: slug, slug, ownerId, currency: 'EGP', template: 'qamar' },
    });
    storeId = store.id;
    await seedCoaForStore(storeId);
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.journalLine.deleteMany({ where: { entry: { storeId } } }).catch(() => {});
      await tx.journalEntry.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.walletTransaction.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.customerWallet.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.payment.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.account.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: TAG } } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
    });
  });

  async function newCustomer(): Promise<string> {
    const u = await prisma.user.create({
      data: {
        email: `${uid('cust')}@example.test`,
        passwordHash: 'x',
        firstName: 'C',
        lastName: 'D',
        role: 'customer',
        storeId,
      },
    });
    return u.id;
  }

  /** Trial balance for one account code: credits minus debits across all posted/reversed lines. */
  async function creditBalance(code: string): Promise<number> {
    const acct = await prisma.account.findFirstOrThrow({ where: { storeId, code } });
    const agg = await prisma.journalLine.aggregate({
      where: { accountId: acct.id, entry: { storeId } },
      _sum: { debit: true, credit: true },
    });
    return (agg._sum.credit ?? 0) - (agg._sum.debit ?? 0);
  }
  async function walletSum(): Promise<number> {
    const agg = await prisma.customerWallet.aggregate({
      where: { storeId },
      _sum: { balance: true },
    });
    return agg._sum.balance ?? 0;
  }
  const adjust = (customerId: string, amount: number, key = uid('adj')) =>
    inStore(() =>
      WalletService.adminAdjust({
        storeId,
        customerId,
        amount,
        note: 'goodwill',
        actorId: ownerId,
        requestKey: key,
      })
    );

  async function walletOrder(customerId: string, total: number, walletAmount: number) {
    const order = await prisma.order.create({
      data: {
        storeId,
        customerId,
        orderNumber: `W-${uid('o')}`,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: total,
        discount: 0,
        tax: 0,
        shipping: 0,
        total,
        walletAmount,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
      },
    });
    if (walletAmount > 0) {
      await inStore(() =>
        WalletService.applyEntry({
          storeId,
          customerId,
          amount: -walletAmount,
          type: 'order_payment',
          idempotencyKey: `order-payment:${order.id}`,
          orderId: order.id,
        })
      );
    }
    await inStore(() => postOrderPaymentJournal({ orderId: order.id }));
    return order;
  }

  it('issue, admin reversal, redemption, whole-order refund and a forfeit all keep 2150 == sum(wallets)', async () => {
    const a = await newCustomer();
    const b = await newCustomer();

    await adjust(a, 10_000);
    await adjust(b, 4_000);
    await adjust(a, -1_500); // admin reverses part of a credit
    expect(await creditBalance('2150')).toBe(await walletSum());
    expect(await creditBalance('5950')).toBe(-12_500); // goodwill expense, net debit

    // a spends 3 000 of the wallet on a 8 000 order (the cash part 5 000 is journaled normally)
    const order = await walletOrder(a, 8_000, 3_000);
    expect(await walletSum()).toBe(5_500 + 4_000);
    expect(await creditBalance('2150')).toBe(await walletSum());
    const cash = await prisma.journalLine.aggregate({
      where: {
        entry: { storeId, source: 'order', sourceId: order.id },
        account: { code: { startsWith: '10' } },
      },
      _sum: { debit: true },
    });
    expect(cash._sum.debit).toBe(5_000);

    // the whole order is refunded: the sale is reversed (2150 credited back) and the spend returns
    await inStore(() => postRefundJournal({ orderId: order.id, storeId }));
    await inStore(() => WalletService.reverseOrderPayment({ storeId, orderId: order.id }));
    expect(await walletSum()).toBe(8_500 + 4_000);
    expect(await creditBalance('2150')).toBe(await walletSum());

    // b is erased: the remaining balance is written off to "unused store credit"
    await prisma.$transaction(async tx => {
      await WalletService.forfeitOnErasure(b, tx as never, { storeId, actorId: 'system' });
    });
    expect(await creditBalance('4100')).toBe(4_000);
    expect(await creditBalance('2150')).toBe(await walletSum());
    expect(await walletSum()).toBe(8_500);
  });

  it('a replayed movement journals exactly once', async () => {
    const c = await newCustomer();
    const key = uid('replay');
    const before = await creditBalance('2150');
    await adjust(c, 700, key);
    await adjust(c, 700, key);
    expect(await creditBalance('2150')).toBe(before + 700);
  });

  it('a wallet-only order journals the WHOLE order (no more unjournaled orders)', async () => {
    const c = await newCustomer();
    await adjust(c, 2_000);
    const order = await walletOrder(c, 2_000, 2_000);
    const entry = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: order.id },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    expect(entry).not.toBeNull();
    expect(entry!.lines.some(l => l.account.code === '2150' && l.debit === 2_000)).toBe(true);
    expect(entry!.lines.some(l => l.account.code.startsWith('10') && l.debit > 0)).toBe(false);
  });
});
