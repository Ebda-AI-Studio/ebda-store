'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPatch } from '@/lib/api';
import { filsToKwd } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

type MatchStatus = 'unmatched' | 'auto_matched' | 'manual_matched' | 'ignored';

interface BankTx {
  id: string;
  date: string;
  description: string;
  amountFils: number;
  direction: 'debit' | 'credit';
  externalRef: string | null;
  matchStatus: MatchStatus;
  confidence: number;
  matchedJournalEntryId: string | null;
  matchedJournalEntry: {
    id: string;
    entryNumber: string;
    postedAt: string;
    memo: string | null;
    source: string;
  } | null;
}

interface Summary {
  total: number;
  autoMatched: number;
  manualMatched: number;
  unmatched: number;
  ignored: number;
  matchedAmountFils: number;
  unmatchedAmountFils: number;
}

interface ReconciliationDifference {
  bankBalanceFils: number;
  ledgerBalanceFils: number;
  differenceFils: number;
  unmatchedBankFils: number;
  unmatchedLedgerFils: number;
  unmatchedLedgerCount: number;
  suggestedActionEn: string;
  suggestedActionAr: string;
  isReconciled: boolean;
}

interface StatementDetail {
  id: string;
  fileName: string;
  importedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
  glAccount: { id: string; code: string; nameEn: string; nameAr: string | null };
  summary: Summary;
  difference: ReconciliationDifference;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const kwd = filsToKwd;

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB');
}

const MATCH_BADGE: Record<MatchStatus, string> = {
  unmatched: 'bg-red-100 text-red-700',
  auto_matched: 'bg-green-100 text-green-700',
  manual_matched: 'bg-blue-100 text-blue-700',
  ignored: 'bg-muted text-muted-ink',
};

type FilterOption = MatchStatus | 'all';

// ─── Manual match modal ───────────────────────────────────────────────────────

interface ManualMatchModalProps {
  txId: string;
  onClose: () => void;
  onConfirm: (txId: string, journalEntryId: string) => Promise<void>;
}

function ManualMatchModal({ txId, onClose, onConfirm }: ManualMatchModalProps) {
  const t = useT('finance.bankRec.manualMatchModal');
  const [entryId, setEntryId] = useState('');
  const [loading, setLoading] = useState(false);

  async function handle() {
    if (!entryId.trim()) return;
    setLoading(true);
    await onConfirm(txId, entryId.trim());
    setLoading(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-sm rounded-xl bg-card p-6 shadow-xl">
        <h3 className="mb-4 text-base font-semibold text-foreground">{t('title')}</h3>
        <label className="block text-sm font-medium text-foreground mb-1.5">{t('entryId')}</label>
        <input
          type="text"
          value={entryId}
          onChange={e => setEntryId(e.target.value)}
          placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
          className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('entryIdHelp')}</p>
        <div className="mt-5 flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/50"
          >
            {t('cancel')}
          </button>
          <button
            onClick={handle}
            disabled={!entryId.trim() || loading}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            {loading ? t('confirming') : t('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StatementDetailPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const statementId = params?.statementId as string;
  const router = useRouter();
  const t = useT('finance.bankRec');
  const tx_t = useT('finance.bankRec.tx');

  const [stmt, setStmt] = useState<StatementDetail | null>(null);
  const [txs, setTxs] = useState<BankTx[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [filter, setFilter] = useState<FilterOption>('all');
  const [error, setError] = useState<string | null>(null);
  const [autoMatchLoading, setAutoMatchLoading] = useState(false);
  const [autoMatchMsg, setAutoMatchMsg] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [matchModal, setMatchModal] = useState<string | null>(null); // txId

  // ── Fetch statement detail ──
  const fetchStmt = useCallback(async () => {
    if (!storeId || !statementId) return;
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the statement detail — reading `data?.data` double-unwrapped
    // to undefined and the page never rendered a loaded statement (#831
    // sweep).
    const { data, error: err } = await apiGet<StatementDetail>(
      `/api/v1/stores/${storeId}/finance/bank-statements/${statementId}`
    );
    if (err) {
      setError(err.message ?? t('errors.loadStatement'));
      return;
    }
    setStmt(data ?? null);
  }, [storeId, statementId]);

  // ── Fetch transactions ──
  const fetchTxs = useCallback(async () => {
    if (!storeId || !statementId) return;
    const qs = filter !== 'all' ? `&matchStatus=${filter}` : '';
    // Same double-unwrap: `data` IS the transaction array. `meta.total` is
    // not recoverable through apiGet (it drops the sibling), so the count
    // falls back to the fetched-page length — correct as long as the
    // statement has ≤200 transactions (the requested perPage); beyond that
    // it undercounts. A true fix needs a raw-response variant of apiGet
    // that preserves `meta`.
    const { data, error: err } = await apiGet<BankTx[]>(
      `/api/v1/stores/${storeId}/finance/bank-statements/${statementId}/transactions?perPage=200${qs}`
    );
    if (err) {
      setError(err.message ?? t('errors.loadTransactions'));
      return;
    }
    setTxs(data ?? []);
    setTxTotal(data?.length ?? 0);
  }, [storeId, statementId, filter]);

  useEffect(() => {
    fetchStmt();
  }, [fetchStmt]);
  useEffect(() => {
    fetchTxs();
  }, [fetchTxs]);

  // ── Auto-match ──
  async function handleAutoMatch() {
    setAutoMatchLoading(true);
    setAutoMatchMsg(null);
    // apiPost already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the match-result object — reading `data?.data` double-
    // unwrapped to undefined and the result message never showed (#831
    // sweep).
    const { data, error: err } = await apiPost<{
      matched: number;
      unmatched: number;
      ambiguous: number;
    }>(`/api/v1/stores/${storeId}/finance/bank-statements/${statementId}/auto-match`);
    setAutoMatchLoading(false);
    if (err) {
      setAutoMatchMsg(t('errors.autoMatch', { message: err.message ?? '' }));
      return;
    }
    const r = data;
    if (r) {
      setAutoMatchMsg(
        t('autoMatchResult')
          .replace('{matched}', String(r.matched))
          .replace('{unmatched}', String(r.unmatched))
          .replace('{ambiguous}', String(r.ambiguous))
      );
    }
    fetchStmt();
    fetchTxs();
  }

  // ── Manual override ──
  async function handleAction(txId: string, action: 'unmatch' | 'ignore') {
    setActionLoading(txId);
    const { error: err } = await apiPatch(
      `/api/v1/stores/${storeId}/finance/bank-statements/${statementId}/transactions/${txId}`,
      { action }
    );
    setActionLoading(null);
    if (err) {
      alert(err.message ?? t('errors.action'));
      return;
    }
    fetchStmt();
    fetchTxs();
  }

  async function handleManualMatch(txId: string, journalEntryId: string) {
    const { error: err } = await apiPatch(
      `/api/v1/stores/${storeId}/finance/bank-statements/${statementId}/transactions/${txId}`,
      { action: 'match', journalEntryId }
    );
    if (err) {
      alert(err.message ?? t('errors.match'));
      return;
    }
    fetchStmt();
    fetchTxs();
  }

  const summary = stmt?.summary;
  const difference = stmt?.difference;

  const FILTER_OPTIONS: { value: FilterOption; label: string }[] = [
    { value: 'all', label: t('filterAll') },
    { value: 'unmatched', label: tx_t('statusLabels.unmatched') },
    { value: 'auto_matched', label: tx_t('statusLabels.auto_matched') },
    { value: 'manual_matched', label: tx_t('statusLabels.manual_matched') },
    { value: 'ignored', label: tx_t('statusLabels.ignored') },
  ];

  return (
    <AdminLayout title={stmt?.fileName ?? t('title')}>
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <button
              onClick={() => router.push(`/stores/${storeId}/finance/bank-reconciliation`)}
              className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              ← {t('title')}
            </button>
            <h1 className="text-xl font-semibold text-foreground">{stmt?.fileName ?? '…'}</h1>
            {stmt && (
              <p className="mt-0.5 text-sm text-muted-foreground">
                {stmt.glAccount.code} — {stmt.glAccount.nameEn}
                {stmt.periodStart && ` · ${fmt(stmt.periodStart)} – ${fmt(stmt.periodEnd)}`}
              </p>
            )}
          </div>
          <button
            onClick={handleAutoMatch}
            disabled={autoMatchLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-40"
          >
            {autoMatchLoading ? t('autoMatching') : t('autoMatch')}
          </button>
        </div>

        {autoMatchMsg && (
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">
            {autoMatchMsg}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Summary cards */}
        {summary && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {[
              { label: t('summary.total'), value: summary.total },
              { label: t('summary.autoMatched'), value: summary.autoMatched },
              { label: t('summary.manualMatched'), value: summary.manualMatched },
              { label: t('summary.unmatched'), value: summary.unmatched },
              { label: t('summary.ignored'), value: summary.ignored },
              { label: t('summary.matchedAmount'), value: `KWD ${kwd(summary.matchedAmountFils)}` },
              {
                label: t('summary.unmatchedAmount'),
                value: `KWD ${kwd(summary.unmatchedAmountFils)}`,
              },
            ].map(card => (
              <div
                key={card.label}
                className="rounded-xl border border-border bg-card p-3 shadow-sm"
              >
                <p className="text-xs text-muted-foreground leading-tight">{card.label}</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{card.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Reconciliation difference panel */}
        {difference && (
          <div
            className={`rounded-xl border p-4 shadow-sm ${
              difference.isReconciled ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">{t('difference.title')}</h2>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  difference.isReconciled
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                {difference.isReconciled ? t('difference.reconciled') : t('difference.mismatch')}
              </span>
            </div>

            {/* Balance row */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
                <p className="text-xs text-muted-foreground leading-tight">
                  {t('difference.bankBalance')}
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground font-mono">
                  {difference.bankBalanceFils < 0 ? '−' : ''}KWD{' '}
                  {kwd(Math.abs(difference.bankBalanceFils))}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
                <p className="text-xs text-muted-foreground leading-tight">
                  {t('difference.ledgerBalance')}
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground font-mono">
                  {difference.ledgerBalanceFils < 0 ? '−' : ''}KWD{' '}
                  {kwd(Math.abs(difference.ledgerBalanceFils))}
                </p>
              </div>
              <div
                className={`rounded-lg border p-3 shadow-sm ${
                  difference.isReconciled
                    ? 'border-green-200 bg-green-100'
                    : 'border-red-200 bg-red-100'
                }`}
              >
                <p className="text-xs text-muted-foreground leading-tight">
                  {t('difference.delta')}
                </p>
                <p
                  className={`mt-1 text-lg font-bold font-mono ${
                    difference.isReconciled ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {difference.differenceFils < 0 ? '−' : difference.differenceFils > 0 ? '+' : ''}
                  KWD {kwd(Math.abs(difference.differenceFils))}
                </p>
              </div>
            </div>

            {/* Where breakdown */}
            {!difference.isReconciled && (
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-amber-100 bg-amber-50 p-3">
                  <p className="text-xs font-medium text-amber-700">
                    {t('difference.unmatchedBankSide')}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-amber-900 font-mono">
                    KWD {kwd(difference.unmatchedBankFils)}
                  </p>
                  <p className="mt-0.5 text-xs text-amber-600">
                    {summary?.unmatched ?? 0} {t('difference.bankLines')}
                  </p>
                </div>
                <div className="rounded-lg border border-purple-100 bg-purple-50 p-3">
                  <p className="text-xs font-medium text-purple-700">
                    {t('difference.unmatchedLedgerSide')}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-purple-900 font-mono">
                    {difference.unmatchedLedgerFils < 0 ? '−' : ''}KWD{' '}
                    {kwd(Math.abs(difference.unmatchedLedgerFils))}
                  </p>
                  <p className="mt-0.5 text-xs text-purple-600">
                    {difference.unmatchedLedgerCount} {t('difference.ledgerEntries')}
                  </p>
                </div>
              </div>
            )}

            {/* Suggested action */}
            <div
              className={`rounded-lg border p-3 text-sm ${
                difference.isReconciled
                  ? 'border-green-200 bg-card text-green-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              <p className="font-medium mb-0.5">{t('difference.suggestedAction')}</p>
              <p>{difference.suggestedActionEn}</p>
              <p className="mt-1 text-xs opacity-70 text-right" dir="rtl">
                {difference.suggestedActionAr}
              </p>
            </div>
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-2">
          {FILTER_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filter === opt.value
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted text-muted-ink hover:bg-muted/80'
              }`}
            >
              {opt.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground self-center">{txTotal} rows</span>
        </div>

        {/* Transactions table */}
        <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
          {txs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t('noTransactionsMatch')}
            </div>
          ) : (
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {[
                    tx_t('date'),
                    tx_t('description'),
                    tx_t('direction'),
                    tx_t('amount'),
                    tx_t('ref'),
                    tx_t('matchStatus'),
                    tx_t('matchedEntry'),
                    tx_t('actions'),
                  ].map(h => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-3 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {txs.map(tx => (
                  <tr key={tx.id} className="hover:bg-muted/50">
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted-foreground">
                      {fmt(tx.date)}
                    </td>
                    <td
                      className="max-w-[220px] truncate px-3 py-2.5 text-foreground"
                      title={tx.description}
                    >
                      {tx.description}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tx.direction === 'debit' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}
                      >
                        {tx.direction === 'debit' ? tx_t('debit') : tx_t('credit')}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-sm text-foreground">
                      {kwd(tx.amountFils)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {tx.externalRef ?? '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_BADGE[tx.matchStatus]}`}
                      >
                        {tx_t(`statusLabels.${tx.matchStatus}`)}
                        {tx.matchStatus === 'auto_matched' && tx.confidence < 100 && (
                          <span className="ml-1 opacity-60">{tx.confidence}%</span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {tx.matchedJournalEntry ? (
                        <span className="font-mono">{tx.matchedJournalEntry.entryNumber}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {tx.matchStatus === 'unmatched' && (
                          <>
                            <button
                              onClick={() => setMatchModal(tx.id)}
                              className="rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
                            >
                              {tx_t('match')}
                            </button>
                            <button
                              onClick={() => handleAction(tx.id, 'ignore')}
                              disabled={actionLoading === tx.id}
                              className="rounded px-1.5 py-0.5 text-xs font-medium text-muted-ink hover:bg-muted disabled:opacity-40"
                            >
                              {actionLoading === tx.id ? '…' : tx_t('ignore')}
                            </button>
                          </>
                        )}
                        {(tx.matchStatus === 'auto_matched' ||
                          tx.matchStatus === 'manual_matched') && (
                          <button
                            onClick={() => handleAction(tx.id, 'unmatch')}
                            disabled={actionLoading === tx.id}
                            className="rounded px-1.5 py-0.5 text-xs font-medium text-amber-600 hover:bg-amber-50 disabled:opacity-40"
                          >
                            {actionLoading === tx.id ? '…' : tx_t('unmatch')}
                          </button>
                        )}
                        {tx.matchStatus === 'ignored' && (
                          <button
                            onClick={() => handleAction(tx.id, 'unmatch')}
                            disabled={actionLoading === tx.id}
                            className="rounded px-1.5 py-0.5 text-xs font-medium text-muted-ink hover:bg-muted disabled:opacity-40"
                          >
                            {actionLoading === tx.id ? '…' : tx_t('unmatch')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Manual match modal */}
      {matchModal && (
        <ManualMatchModal
          txId={matchModal}
          onClose={() => setMatchModal(null)}
          onConfirm={handleManualMatch}
        />
      )}
    </AdminLayout>
  );
}
