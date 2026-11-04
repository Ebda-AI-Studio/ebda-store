'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiFetch } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountOption {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: string;
}

interface AccountsTree {
  asset: AccountOption[];
  liability: AccountOption[];
  equity: AccountOption[];
  revenue: AccountOption[];
  expense: AccountOption[];
}

interface ImportResult {
  statementId: string;
  imported: number;
  skipped: number;
  parseErrors: string[];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ImportStatementPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('finance.bankRec');
  const ti = useT('finance.bankRec.import');

  const fileRef = useRef<HTMLInputElement>(null);

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── Load bank accounts (asset type) ──
  const loadAccounts = useCallback(async () => {
    if (!storeId) return;
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the accounts tree — reading `data.data` double-unwrapped to
    // undefined and the account dropdown was always empty (#831 sweep).
    const { data } = await apiGet<AccountsTree>(`/api/v1/stores/${storeId}/finance/accounts`);
    if (!data) return;
    // Flatten all accounts; bank accounts are typically assets
    const flat: AccountOption[] = [...(data.asset ?? []), ...(data.liability ?? [])];
    setAccounts(flat);
  }, [storeId]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setResult(null);
    setErrorMsg(null);
  }

  async function handleImport() {
    if (!file || !selectedAccountId) return;
    setImporting(true);
    setErrorMsg(null);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('glAccountId', selectedAccountId);

    try {
      const res = await apiFetch(`/api/v1/stores/${storeId}/finance/bank-statements`, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();

      if (!res.ok) {
        setErrorMsg(json?.message ?? json?.error ?? ti('error'));
        return;
      }

      setResult(json.data as ImportResult);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : ti('error'));
    } finally {
      setImporting(false);
    }
  }

  const canImport = !!file && !!selectedAccountId && !importing;

  return (
    <AdminLayout
      title={ti('title')}
      parent={{ label: t('title'), href: `/stores/${storeId}/finance/bank-reconciliation` }}
    >
      <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-6">
        {/* Form card */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-5">
          {/* GL Account select */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('account')}
            </label>
            <select
              value={selectedAccountId}
              onChange={e => setSelectedAccountId(e.target.value)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">{ti('accountPlaceholder')}</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.nameEn}
                  {a.nameAr ? ` / ${a.nameAr}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* File input */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {ti('selectFile')}
            </label>
            <div
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/50 py-8 transition hover:bg-muted"
            >
              <svg
                className="mb-2 h-8 w-8 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              {file ? (
                <p className="text-sm font-medium text-foreground">{file.name}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{ti('fileTypesHint')}</p>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.ofx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/x-ofx"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          </div>

          {/* Import button */}
          <button
            onClick={handleImport}
            disabled={!canImport}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-40"
          >
            {importing ? ti('importing') : ti('importButton')}
          </button>
        </div>

        {/* Error */}
        {errorMsg && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {errorMsg}
          </div>
        )}

        {/* Success result */}
        {result && (
          <div className="rounded-xl border border-green-100 bg-green-50 p-5 space-y-3">
            <p className="text-sm font-medium text-green-800">
              {ti('success', { count: result.imported })}
            </p>
            <div className="text-sm text-green-700 space-y-1">
              <p>
                {t('imported')}: <strong>{result.imported}</strong>
              </p>
              <p>
                {ti('skippedLabel')}: <strong>{result.skipped}</strong>
              </p>
            </div>
            {result.parseErrors.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-warning-ink mb-1">{ti('parseErrors')}:</p>
                <ul className="list-inside list-disc space-y-0.5">
                  {result.parseErrors.slice(0, 10).map((e, i) => (
                    <li key={i} className="text-xs text-warning-ink">
                      {e}
                    </li>
                  ))}
                  {result.parseErrors.length > 10 && (
                    <li className="text-xs text-warning-ink">
                      {ti('andMore', { count: result.parseErrors.length - 10 })}
                    </li>
                  )}
                </ul>
              </div>
            )}
            <button
              onClick={() =>
                router.push(`/stores/${storeId}/finance/bank-reconciliation/${result.statementId}`)
              }
              className="mt-2 rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800"
            >
              {ti('viewReconciliation')} →
            </button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
