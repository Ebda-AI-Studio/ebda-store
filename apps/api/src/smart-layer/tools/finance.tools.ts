/**
 * Wave 2 (plan 4 C2): finance. Declared with `change()` from ./kit.
 *   - expense_add (finance.expenses): routes/expenses.routes.ts `POST /:storeId/expenses` (`authorize('store_admin')` + `requireFeature('accounting.expenses')`)
 *     calls `createExpense` inside `runInStoreCtx`; so does this tool. It creates a DRAFT expense in EGP: nothing reaches the ledger until the merchant
 *     approves and posts it on the Expenses page (approve / post are NOT assistant tools). It is confirm-class and `money: true` because it books the
 *     merchant's own spend, and `irreversible` because there is no delete service and rejecting a draft is a different tool (the Expenses page does it).
 *     The amount is the merchant's own statement of their own expense, so it is a typed argument in EGP; the card shows it exactly as it will be stored.
 */
import { z } from 'zod/v3';
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { isCashOrBankAccount } from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { runInStoreCtx } from '../../lib/jobs/store-db';
import { createExpense } from '../../services/accounting/expense.service';
import { listAccountsTree, type AccountsTreeNode } from '../../services/accounting/account.service';
import { getSupplier } from '../../services/accounting/supplier.service';
import { change, egp, f, pair, row, shape } from './kit';

type Rec = Record<string, unknown>;
const STORE_ROLES = ['store_admin'] as const; // the routes' `authorize('store_admin', 'super_admin')`; a super admin never acts through the assistant

type ExpenseArgs = {
  expenseAccountId: string;
  paidFromAccountId: string;
  amountEgp: number;
  taxAmountEgp?: number;
  expenseDate: string;
  supplierId?: string;
  notes?: string;
  notesAr?: string;
};

const dateField = {
  z: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
    .refine(v => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'not a real date'),
  js: {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Expense date, YYYY-MM-DD.',
  },
};

const shapeDef = shape<ExpenseArgs>(
  {
    expenseAccountId: f.id('The expense category account (chart of accounts id).'),
    paidFromAccountId: f.id('The cash or bank account the money was paid from.'),
    amountEgp: f.num('Amount in EGP (a decimal number, e.g. 250.5), before tax.', {
      min: 0.01,
      max: 100_000_000,
    }),
    taxAmountEgp: f.num('Tax part in EGP (decimal), if any.', { max: 100_000_000 }),
    expenseDate: dateField,
    supplierId: f.id('The supplier id, if the expense is for a supplier.'),
    notes: f.text('Notes in English.', { max: 1000 }),
    notesAr: f.text('Notes in Arabic.', { max: 1000 }),
  },
  ['expenseAccountId', 'paidFromAccountId', 'amountEgp', 'expenseDate']
);

const flatten = (nodes: AccountsTreeNode[]): AccountsTreeNode[] =>
  nodes.flatMap(n => [n, ...flatten(n.children)]);
const piasters = (egpValue: number) => Math.round(egpValue * 100);

type ExpenseState = {
  expenseAccount: Rec;
  paidFrom: Rec;
  supplier: Rec | null;
};
const acct = (n: AccountsTreeNode): Rec => ({
  id: n.id,
  code: n.code,
  nameEn: n.nameEn,
  nameAr: n.nameAr,
});
const label = (x: Rec | null) => (x ? `${x.code} ${x.nameAr ?? x.nameEn}` : null);

const expenseAdd = change<ExpenseArgs>({
  name: 'expense_add',
  capabilityId: 'finance.expenses',
  description:
    'Record an expense as a DRAFT in the books: category account, the cash or bank account it was paid from, the amount in EGP (decimal, e.g. 250.5), the date, optional tax, supplier and notes. It stays a draft until the merchant approves and posts it on the Expenses page.',
  schema: shapeDef,
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  gate: { roles: STORE_ROLES, feature: 'accounting.expenses' },
  audit: { action: 'expense.assistant_created', resourceType: 'expense' },
  state: async (ctx, a): Promise<ExpenseState> => {
    const tree = await listAccountsTree(ctx.storeId); // store-scoped: a foreign account id is simply not in it
    const all = Object.values(tree).flatMap(nodes => flatten(nodes as AccountsTreeNode[]));
    const expenseAccount = all.find(n => n.id === a.expenseAccountId);
    const paidFrom = all.find(n => n.id === a.paidFromAccountId);
    if (!expenseAccount || !paidFrom)
      throw new AppError(404, 'NOT_FOUND', 'One or more referenced records were not found');
    // same money guard as createExpense: the paid-from account must be cash or bank, so the entry is debit expense / credit cash
    if (!isCashOrBankAccount({ code: paidFrom.code, type: paidFrom.type }))
      throw new AppError(400, 'INVALID_PAID_FROM', 'Paid-from must be a cash or bank account.');
    let supplier: Rec | null = null;
    if (a.supplierId) {
      const s = await getSupplier(ctx.storeId, a.supplierId);
      if (!s) throw new AppError(404, 'NOT_FOUND', 'One or more referenced records were not found');
      supplier = { id: s.id, name: s.name };
    }
    return { expenseAccount: acct(expenseAccount), paidFrom: acct(paidFrom), supplier };
  },
  describe: (_ctx, a, st) => {
    const s = st as ExpenseState;
    const amount = piasters(a.amountEgp);
    const tax = piasters(a.taxAmountEgp ?? 0);
    const rows = [
      row('المبلغ (ج.م)', 'Amount (EGP)', null, egp(amount)),
      row('الضريبة (ج.م)', 'Tax (EGP)', null, egp(tax)),
      row('الإجمالي (ج.م)', 'Total (EGP)', null, egp(amount + tax)),
      row('تاريخ المصروف', 'Expense date', null, a.expenseDate),
      row('فئة المصروف', 'Expense category', null, label(s.expenseAccount)),
      row('الدفع من حساب', 'Paid from account', null, label(s.paidFrom)),
      ...(s.supplier ? [row('المورد', 'Supplier', null, s.supplier.name)] : []),
      ...(a.notes ? [row('ملاحظات', 'Notes', null, a.notes)] : []),
      ...(a.notesAr ? [row('ملاحظات (عربي)', 'Notes (Arabic)', null, a.notesAr)] : []),
      row(
        'الحالة بعد التنفيذ',
        'Status after applying',
        null,
        'مسودة: مش هتدخل الدفاتر غير لما تعتمدها وترحّلها من صفحة المصروفات / Draft: it only reaches the books when you approve and post it on the Expenses page'
      ),
    ];
    return {
      summary: pair(
        `تسجيل مصروف ${egp(amount + tax)} ج.م كمسودة (غير قابل للتراجع من المساعد)`,
        `Record an expense of EGP ${egp(amount + tax)} as a draft (cannot be undone from the assistant)`
      ),
      rows,
      affectedCount: 1,
    };
  },
  run: (ctx, a) =>
    runInStoreCtx(ctx.storeId, () =>
      createExpense({
        storeId: ctx.storeId,
        createdBy: ctx.userId,
        expenseAccountId: a.expenseAccountId,
        paidFromAccountId: a.paidFromAccountId,
        amount: piasters(a.amountEgp),
        ...(a.taxAmountEgp ? { taxAmount: piasters(a.taxAmountEgp) } : {}),
        expenseDate: new Date(`${a.expenseDate}T00:00:00.000Z`),
        ...(a.supplierId ? { supplierId: a.supplierId } : {}),
        ...(a.notes ? { notes: a.notes } : {}),
        ...(a.notesAr ? { notesAr: a.notesAr } : {}),
      })
    ),
});

export function financeTools(): ToolSpec[] {
  return [expenseAdd];
}
