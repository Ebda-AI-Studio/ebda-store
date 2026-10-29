'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, getApiUrl, localizedApiMessage } from '@/lib/api';
import { minorToMajor } from '@/lib/format';
import { resolveUploadErrorMessage } from '@/lib/expense-upload-error';
import {
  isCashOrBankAccount,
  ALLOWED_CURRENCIES,
  convertToBase,
  requiresFxRate,
  minorToDecimalString,
  roundToMinor,
  REGION,
} from '@ebda/shared';

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

interface ExpenseListItem {
  id: string;
  createdAt: string;
  status: string;
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

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_POLLS = 15;
const POLL_INTERVAL_MS = 2000;

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
  const [currency, setCurrency] = useState(REGION.currency);
  const [fxRate, setFxRate] = useState('');
  const [notes, setNotes] = useState('');
  const [notesAr, setNotesAr] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [multiCurrencyEnabled, setMultiCurrencyEnabled] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OCR upload state
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrUploading, setOcrUploading] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<
    'idle' | 'processing' | 'success' | 'timeout' | 'error'
  >('idle');
  const [ocrMessage, setOcrMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!storeId) return;

    // Load accounts
    apiGet<AccountsTree>(`/api/v1/stores/${storeId}/finance/accounts`).then(({ data }) => {
      if (!data) return;
      const allExpense = flattenTree(data.expenses ?? []).sort((a, b) =>
        a.code.localeCompare(b.code)
      );
      // "Paid From" must be a cash/bank account (1000–1099 band) so the
      // double-entry stays correct (debit expense, credit cash). Paying "from"
      // Inventory / Fixed Assets / AR would record a wrong credit, so they are
      // filtered out of the dropdown here AND rejected server-side.
      const cashBankAssets = flattenTree(data.assets ?? [])
        .filter(isCashOrBankAccount)
        .sort((a, b) => a.code.localeCompare(b.code));
      setExpenseAccounts(allExpense);
      setAssetAccounts(cashBankAssets);
    });

    // Load suppliers
    apiGet<SupplierRow[]>(`/api/v1/stores/${storeId}/suppliers`).then(({ data }) => {
      setSuppliers(data ?? []);
    });

    // Check multi-currency feature flag via the store-admin endpoint
    apiGet<{ features: Record<string, boolean> }>(`/api/v1/stores/${storeId}/my-features`)
      .then(({ data }) => {
        setMultiCurrencyEnabled(data?.features?.['accounting.multi_currency'] === true);
      })
      .catch(() => {
        // Feature check failure is non-fatal — default to EGP-only
      });

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [storeId]);

  // ── OCR upload handler ───────────────────────────────────────────────────

  async function handleOcrUpload() {
    if (!ocrFile || !storeId) return;

    if (!ALLOWED_TYPES.includes(ocrFile.type)) {
      setOcrStatus('error');
      setOcrMessage(t('ocr.unsupported'));
      return;
    }

    setOcrUploading(true);
    setOcrStatus('processing');
    setOcrMessage(t('ocr.processing'));

    // Snapshot current draft count before upload (for polling comparison)
    const beforeTs = Date.now();

    // POST multipart
    const formData = new FormData();
    formData.append('file', ocrFile);

    try {
      const csrfToken = typeof window !== 'undefined' ? localStorage.getItem('csrfToken') : null;
      const accessToken =
        typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

      const headers: Record<string, string> = {};
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

      const uploadRes = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/expenses/upload-receipt`,
        {
          method: 'POST',
          credentials: 'include',
          headers,
          body: formData,
        }
      );

      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}));
        setOcrStatus('error');
        // A byte-sniff refusal carries both languages in error.details (B0-46).
        setOcrMessage(
          localizedApiMessage(
            undefined,
            resolveUploadErrorMessage(body) ??
              t('uploadFailedGeneric', { status: uploadRes.status }),
            (body as { error?: { details?: Record<string, unknown> } })?.error?.details
          )
        );
        setOcrUploading(false);
        return;
      }
    } catch {
      setOcrStatus('error');
      setOcrMessage(t('uploadFailedRetry'));
      setOcrUploading(false);
      return;
    }

    // Poll for the new draft expense (created within last 60s)
    let polls = 0;

    function schedulePoll() {
      pollTimerRef.current = setTimeout(async () => {
        polls += 1;

        // GET /expenses returns `{ data: items, meta }` — apiGet unwraps one
        // layer AND drops the sibling `meta`, so `data` IS the item array;
        // reading `data?.data` double-unwrapped to undefined and this poll
        // never found the newly-created draft (#831 sweep).
        const { data } = await apiGet<ExpenseListItem[]>(
          `/api/v1/stores/${storeId}/expenses?status=draft&hasOcr=true&perPage=1`
        );

        const items = data ?? [];
        const newest = items[0];

        if (newest) {
          const createdMs = new Date(newest.createdAt).getTime();
          // Accept if created after we started the upload
          if (createdMs >= beforeTs - 5000) {
            setOcrStatus('success');
            setOcrMessage(t('ocr.success'));
            setOcrUploading(false);
            // invalidate App Router cache so the destination list re-fetches the saved row
            router.refresh();
            router.push(`/stores/${storeId}/finance/expenses`);
            return;
          }
        }

        if (polls >= MAX_POLLS) {
          setOcrStatus('timeout');
          setOcrMessage(t('ocr.timeout'));
          setOcrUploading(false);
          return;
        }

        schedulePoll();
      }, POLL_INTERVAL_MS);
    }

    schedulePoll();
  }

  // ── Manual form submit ───────────────────────────────────────────────────

  const rawAmount = parseFloat(amount) || 0;
  const rawTax = parseFloat(taxAmount) || 0;
  const isNonBase = multiCurrencyEnabled && requiresFxRate(currency);
  const fxRateNum = Number(fxRate) || 0;

  // For EGP, user types pounds (major units) → convert to piastres for the live preview and payload.
  // For non-EGP, user types minor units directly (convertToBase already works in minor units).
  const rawAmountFils = isNonBase ? rawAmount : roundToMinor(rawAmount);
  const rawTaxFils = isNonBase ? rawTax : roundToMinor(rawTax);

  // Live EGP preview — for non-EGP, use convertToBase; for EGP, already in piastres
  const baseAmountFils =
    isNonBase && fxRateNum > 0 ? convertToBase(rawAmountFils, fxRateNum, currency) : rawAmountFils;
  const baseTaxFils =
    isNonBase && fxRateNum > 0 ? convertToBase(rawTaxFils, fxRateNum, currency) : rawTaxFils;
  const totalFilsBase = baseAmountFils + baseTaxFils;
  const totalMajor = minorToDecimalString(totalFilsBase);

  async function submit() {
    setError(null);
    if (!expenseDate) {
      setError(t('errorExpenseDateRequired'));
      return;
    }
    if (!expenseAccountId) {
      setError(t('errorExpenseCategoryRequired'));
      return;
    }
    if (!paidFromAccountId) {
      setError(t('errorPaidFromRequired'));
      return;
    }
    if (!amount || rawAmountFils <= 0) {
      setError(t('errorAmountRequired'));
      return;
    }
    if (isNonBase && (!fxRate || fxRateNum <= 0)) {
      setError(t('errorFxRateRequired', { currency }));
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        expenseDate,
        supplierId: supplierId || undefined,
        expenseAccountId,
        paidFromAccountId,
        // EGP: user typed major units → already converted to piastres in rawAmountFils/rawTaxFils
        // non-EGP: user typed minor units → rawAmountFils === rawAmount (integer)
        amount: rawAmountFils,
        taxAmount: rawTaxFils,
        currency,
        notes: notes || undefined,
        notesAr: notesAr || undefined,
        receiptUrl: receiptUrl || undefined,
      };

      // Include FX fields only for non-EGP currencies
      if (isNonBase && fxRateNum > 0) {
        payload.fxRate = fxRateNum;
        payload.originalAmount = rawAmountFils;
      }

      const { error: apiError } = await apiPost(`/api/v1/stores/${storeId}/expenses`, payload);

      if (apiError) {
        setError(apiError.message);
        return;
      }

      // invalidate App Router cache so the destination list re-fetches the saved row
      router.refresh();
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
        {/* ── OCR Upload Section ──────────────────────────────────────────── */}
        <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
          <p className="text-sm font-semibold">{t('ocr.title')}</p>

          <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
            <label className="flex-1">
              <span className="sr-only">{t('ocr.selectFile')}</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                disabled={ocrUploading}
                onChange={e => {
                  const f = e.target.files?.[0] ?? null;
                  setOcrFile(f);
                  setOcrStatus('idle');
                  setOcrMessage(null);
                }}
                className="block w-full text-sm text-muted-foreground
                  file:mr-3 file:py-1.5 file:px-3
                  file:rounded file:border file:border-border
                  file:text-xs file:font-medium file:bg-background
                  file:cursor-pointer hover:file:bg-muted/50
                  disabled:opacity-50"
              />
            </label>

            <button
              type="button"
              onClick={handleOcrUpload}
              disabled={ocrUploading || !ocrFile}
              className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium disabled:opacity-50 whitespace-nowrap"
            >
              {ocrUploading ? (
                <span className="flex items-center gap-1.5">
                  <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  {t('ocr.processing')}
                </span>
              ) : (
                t('ocr.upload')
              )}
            </button>
          </div>

          {ocrMessage && (
            <p
              className={`text-xs ${
                ocrStatus === 'error' || ocrStatus === 'timeout'
                  ? 'text-red-600'
                  : ocrStatus === 'success'
                    ? 'text-green-600'
                    : 'text-muted-foreground'
              }`}
            >
              {ocrMessage}
            </p>
          )}

          <p className="text-xs text-muted-foreground">{t('ocr.manualHint')}</p>
        </div>

        {/* ── Manual form ────────────────────────────────────────────────── */}

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
          <span className="text-sm font-medium">{t('supplierLabel')}</span>
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
            {t('expenseCategoryLabel')} <span className="text-red-500">*</span>
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
            {t('paidFromAccountLabel')} <span className="text-red-500">*</span>
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

        {/* Currency selector (shown only when multi-currency feature is enabled) */}
        {multiCurrencyEnabled && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t('currencyLabel')}</span>
              <select
                value={currency}
                onChange={e => {
                  setCurrency(e.target.value);
                  setFxRate('');
                }}
                className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
              >
                {ALLOWED_CURRENCIES.map(c => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {/* FX rate input — only visible when currency ≠ EGP */}
            {requiresFxRate(currency) && (
              <label className="block space-y-1">
                <span className="text-sm font-medium">
                  {t('fxRateLabel', { currency })} <span className="text-red-500">*</span>
                </span>
                <input
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  value={fxRate}
                  onChange={e => setFxRate(e.target.value)}
                  className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm font-mono"
                  placeholder={t('fxRatePlaceholder')}
                  required
                />
                <p className="text-xs text-muted-foreground">{t('fxRateHint')}</p>
              </label>
            )}
          </div>
        )}

        {/* Amount + Tax */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">
              {t('amount')} {isNonBase ? t('minorUnitsSuffix', { currency }) : ''}{' '}
              <span className="text-red-500">*</span>
            </span>
            <input
              type="number"
              min={isNonBase ? '1' : '0.01'}
              step={isNonBase ? '1' : '0.01'}
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm font-mono"
              placeholder="0"
              required
            />
            {isNonBase && rawAmount > 0 && fxRateNum > 0 && (
              <p className="text-xs text-muted-foreground">
                = {minorToMajor(baseAmountFils)} {tc('egp')}
              </p>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">
              {t('taxAmount')} {isNonBase ? t('minorUnitsSuffix', { currency }) : ''}
            </span>
            <input
              type="number"
              min="0"
              step={isNonBase ? '1' : '0.01'}
              value={taxAmount}
              onChange={e => setTaxAmount(e.target.value)}
              className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm font-mono"
            />
            {isNonBase && rawTax > 0 && fxRateNum > 0 && (
              <p className="text-xs text-muted-foreground">
                = {minorToMajor(baseTaxFils)} {tc('egp')}
              </p>
            )}
          </label>
        </div>

        {/* EGP total display */}
        <div className="rounded-lg bg-muted/30 px-4 py-3 text-sm">
          {isNonBase && fxRateNum > 0 ? (
            <>
              <span className="text-muted-foreground">
                {t('totalInBaseConverted', { rate: fxRateNum })}{' '}
              </span>
              <span className="font-semibold font-mono">
                {totalMajor} {tc('egp')}
              </span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground">{t('totalInBase')}: </span>
              <span className="font-semibold font-mono">
                {totalMajor} {tc('egp')}
              </span>
            </>
          )}
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
