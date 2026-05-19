import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import {
  seedCoaForStore,
  getSystemAccountIdByCode,
} from '../../../apps/api/src/services/accounting/account.service';
import {
  createExpense,
  approveExpense,
  postExpense,
  rejectExpense,
} from '../../../apps/api/src/services/accounting/expense.service';
import { postExpenseJournal } from '../../../apps/api/src/services/accounting/posting/expense-posting';

const OWNER = '00000000-0000-0000-0000-0000000000aa';
let storeId: string;
let marketingAccountId: string;
let cashAccountId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `exp-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'E',
      lastName: 'O',
    },
  });
  const s = await prisma.store.create({
    data: { name: `exp-test-${Date.now()}`, slug: `exp-test-${Date.now()}`, ownerId: OWNER },
  });
  storeId = s.id;
  await seedCoaForStore(storeId);
  marketingAccountId = await getSystemAccountIdByCode(storeId, '5200'); // Marketing
  cashAccountId = await getSystemAccountIdByCode(storeId, '1000'); // Cash KNET
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.expense.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('expense lifecycle: draft → approve → post → journal', () => {
  it('happy path single-step approval', async () => {
    const exp = await createExpense({
      storeId,
      expenseAccountId: marketingAccountId,
      paidFromAccountId: cashAccountId,
      amount: 50000, // 50 KWD
      taxAmount: 0,
      expenseDate: new Date(),
      notes: 'Test FB ad spend',
      createdBy: OWNER,
    });
    expect(exp.status).toBe('draft');
    expect(exp.total).toBe(50000);
    expect(exp.expenseNumber).toMatch(/^EXP-\d{4}-\d{6}$/);

    const approved = await approveExpense(storeId, exp.id, OWNER);
    expect(approved.status).toBe('approved');

    const posted = await postExpense(storeId, exp.id);
    expect(posted.status).toBe('posted');
    expect(posted.postedAt).not.toBeNull();

    // Direct posting helper (Inngest async)
    await postExpenseJournal({ storeId, expenseId: exp.id });

    const entry = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'expense', sourceId: exp.id },
      include: { lines: { include: { account: true } } },
    });
    expect(entry).not.toBeNull();
    const dr = entry!.lines.reduce((s, l) => s + l.debit, 0);
    const cr = entry!.lines.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBe(cr);
    expect(dr).toBe(50000);

    const drLine = entry!.lines.find(l => l.debit === 50000);
    const crLine = entry!.lines.find(l => l.credit === 50000);
    expect(drLine?.account.code).toBe('5200'); // Marketing
    expect(crLine?.account.code).toBe('1000'); // Cash KNET
  });

  it('reject path: rejected expense cannot be posted', async () => {
    const exp = await createExpense({
      storeId,
      expenseAccountId: marketingAccountId,
      paidFromAccountId: cashAccountId,
      amount: 25000,
      expenseDate: new Date(),
    });
    await rejectExpense(storeId, exp.id);
    const rejected = await prisma.expense.findUnique({ where: { id: exp.id } });
    expect(rejected?.status).toBe('rejected');

    // Cannot approve/post a rejected expense
    await expect(approveExpense(storeId, exp.id, OWNER)).rejects.toThrow();
    await expect(postExpense(storeId, exp.id)).rejects.toThrow();
  });

  it('cannot post a non-approved expense', async () => {
    const exp = await createExpense({
      storeId,
      expenseAccountId: marketingAccountId,
      paidFromAccountId: cashAccountId,
      amount: 10000,
      expenseDate: new Date(),
    });
    await expect(postExpense(storeId, exp.id)).rejects.toThrow();
  });
});
