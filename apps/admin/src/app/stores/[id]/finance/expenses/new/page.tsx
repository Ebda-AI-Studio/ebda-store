'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountNode {
  id: string;
  code: string;
  nameEn: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  children: AccountNode[];
}

interface AccountsTree {
  assets: AccountNode[];
  liabilities: AccountNode[];
  equity: AccountNode[];
  revenue: AccountNode[];
  expenses: AccountNode[];
}

interface SupplierRow {
  id: string;
  name: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flattenTree(nodes: AccountNode[]): AccountNode[] {
  const result: AccountNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewExpensePage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('finance.expenses.new');
  const tc = useT('common');

  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<AccountNode[]>([]);
  const [assetAccounts, setAssetAccounts] = useState<AccountNode[]>([]);

  // Form state
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [supplierId, setSupplierId] = useState('');
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [paidFromAccountId, setPaidFromAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [taxAmount, setTaxAmount] = useState('0');
  const [notes, setNotes] = useState('');
  const [notesAr, setNotesAr] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;

    // Load accounts
    apiGet<AccountsTree>(`/api/v1/stores/${storeId}/finance/accounts`).then(({ data }) => {
      if (!data) return;
      const allExpense = flattenTree(data.expenses ?? []).sort((a, b) =>
        a.code.localeCompare(b.code)
      );
      const allAsset = flattenTree(data.assets ?? []).sort((a, b) => a.code.localeCompare(b.code));
      setExpenseAccounts(allExpense);
      setAssetAccounts(allAsset);
    });

    // Load suppliers
    apiGet<SupplierRow[]>(`/api/v1/stores/${storeId}/suppliers`).then(({ data }) => {
      setSuppliers(data ?? []);
    });
  }, [storeId]);

  const totalFils = (Number(amount) || 0) + (Number(taxAmount) || 0);
  const totalKwd = (totalFils / 1000).toFixed(3);

  async function submit() {
    setError(null);
    if (!expenseDate) {
      setError('Expense date is required');
      return;
    }
    if (!expenseAccountId) {
      setError('Expense category is required');
      return;
    }
    if (!paidFromAccountId) {
      setError('Paid-from account is required');
      return;
    }
    if (!amount || Number(amount) <= 0) {
      setError('Amount must be greater than 0');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        expenseDate,
        supplierId: supplierId || undefined,
        expenseAccountId,
        paidFromAccountId,
        amount: Math.round(Number(amount)),
        taxAmount: Math.round(Number(taxAmount) || 0),
        notes: notes || undefined,
        notesAr: notesAr || undefined,
        receiptUrl: receiptUrl || undefined,
      };

      const { error: apiError } = await apiPost(`/api/v1/stores/${storeId}/expenses`, payload);

      if (apiError) {
        setError(apiError.message);
        return;
      }

      router.push(`/stores/${storeId}/finance/expenses`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={t('title')}>
      <div className="max-w-2xl space-y-5">
        {/* Expense Date */}
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            {t('expenseDate')} <span className="text-red-500">*</span>
          </span>
          <input
            type="date"
            value={expenseDate}
            onChange={e => setExpenseDate(e.target.value)}
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            required
          />
        </label>

        {/* Supplier */}
        <label className="block space-y-1">
          <span className="text-sm font-medium">Supplier</span>
          <select
            value={supplierId}
            onChange={e => setSupplierId(e.target.value)}
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
          >
            <option value="">{t('selectSupplier')}</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        {/* Expense Account */}
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Expense Category <span className="text-red-500">*</span>
          </span>
          <select
            value={expenseAccountId}
            onChange={e => setExpenseAccountId(e.target.value)}
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            required
          >
            <option value="">{t('selectExpenseAccount')}</option>
            {expenseAccounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.nameEn}
              </option>
            ))}
          </select>
        </label>

        {/* Paid From Account */}
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Paid From Account <span className="text-red-500">*</span>
          </span>
          <select
            value={paidFromAccountId}
            onChange={e => setPaidFromAccountId(e.target.value)}
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            required
          >
            <option value="">{t('selectPaidFromAccount')}</option>
            {assetAccounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.nameEn}
              </option>
            ))}
          </select>
        </label>

        {/* Amount + Tax */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">
              {t('amount')} <span className="text-red-500">*</span>
            </span>
            <input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm font-mono"
              placeholder="0"
              required
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('taxAmount')}</span>
            <input
              type="number"
              min="0"
              step="1"
              value={taxAmount}
              onChange={e => setTaxAmount(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm font-mono"
            />
          </label>
        </div>

        {/* KWD total display */}
        <div className="rounded-lg bg-muted/30 px-4 py-3 text-sm">
          <span className="text-muted-foreground">{t('totalInKwd')}: </span>
          <span className="font-semibold font-mono">{totalKwd} KWD</span>
        </div>

        {/* Notes */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('notes')}</span>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
            />
          </label>
          <label className="block space-y-1" dir="rtl">
            <span className="text-sm font-medium">{t('notesAr')}</span>
            <textarea
              value={notesAr}
              onChange={e => setNotesAr(e.target.value)}
              rows={3}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
              dir="rtl"
            />
          </label>
        </div>

        {/* Receipt URL */}
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t('receiptUrl')}</span>
          <input
            type="url"
            value={receiptUrl}
            onChange={e => setReceiptUrl(e.target.value)}
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
            placeholder="https://..."
          />
          <p className="text-xs text-muted-foreground">{t('receiptHint')}</p>
        </label>

        {error && <div className="text-red-600 text-sm">{error}</div>}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium disabled:opacity-50"
          >
            {submitting ? tc('saving') : t('submit')}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/finance/expenses`)}
            className="px-4 py-2 border border-border rounded text-sm"
          >
            {tc('cancel')}
          </button>
        </div>
      </div>
    </AdminLayout>
  );
}
