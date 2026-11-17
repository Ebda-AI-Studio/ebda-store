'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiGet, apiGetPage, apiPost, apiPatch, type PageMeta } from '@/lib/api';
import { PageControls } from '@/components/PageControls';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { minorToMajor, intlLocaleForUi } from '@/lib/format';
import { withNumerals } from '@ebda/shared';

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

const major = minorToMajor;

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(intlLocaleForUi('en-GB'));
}

const MATCH_BADGE: Record<MatchStatus, string> = {
  unmatched: 'bg-destructive/10 text-destructive-ink',
  auto_matched: 'bg-success/10 text-success-ink',
  manual_matched: 'bg-info/10 text-info-ink',
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
          placeholder={t('uuidExample')}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('entryIdHelp')}</p>
        <div className="mt-5 flex gap-3 justify-end">
          <Button onClick={onClose} variant="outline" size="sm">
            {t('cancel')}
          </Button>
          <Button
            onClick={handle}
            disabled={!entryId.trim() || loading}
            variant="default"
            size="sm"
          >
            {loading ? t('confirming') : t('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StatementDetailPage() {
  const tc = useT('common');
  const params = useParams();
  const storeId = params?.id as string;
  const statementId = params?.statementId as string;
  const { error: toastError } = useToast();
  const t = useT('finance.bankRec');
  const tx_t = useT('finance.bankRec.tx');

  const [stmt, setStmt] = useState<StatementDetail | null>(null);
  const [txs, setTxs] = useState<BankTx[]>([]);
  const [txMeta, setTxMeta] = useState<PageMeta | null>(null);
  const [txPage, setTxPage] = useState(1);
  const [filter, setFilter] = useState<FilterOption>('all');
  const [error, setError] = useState<string | null>(null);
  const [autoMatchLoading, setAutoMatchLoading] = useState(false);
  const [autoMatchMsg, setAutoMatchMsg] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [matchModal, setMatchModal] = useState<string | null>(null); // txId
  // Bumped after a mutation: the fetch effects own EVERY request, so a refetch reads the CURRENT
  // filter/page instead of the ones captured when the action's button rendered (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);

  // ── Fetch statement detail ──
  // Latest-request-wins with its OWN sequence (a shared one would make the statement and
  // transactions fetches invalidate each other): an older response must not repaint the pre-action
  // summary/difference (`isReconciled`) beside the post-action transaction table (issue 2442).
  const beginStmtRequest = useLatestRequest();
  const fetchStmt = useCallback(async () => {
    if (!storeId || !statementId) return;
    const isLatest = beginStmtRequest();
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the statement detail — reading `data?.data` double-unwrapped
    // to undefined and the page never rendered a loaded statement (#831
    // sweep).
    const { data, error: err } = await apiGet<StatementDetail>(
      `/api/v1/stores/${storeId}/finance/bank-statements/${statementId}`
    );
    if (!isLatest()) return;
    if (err) {
      setError(err.message ?? t('errors.loadStatement'));
      return;
    }
    setError(null);
    setStmt(data ?? null);
  }, [storeId, statementId, beginStmtRequest]);

  // ── Fetch transactions ──
  // Latest-request-wins: a slower response for the previous filter/page must not repaint its rows
  // under the new one (issue 2436).
  const beginTxRequest = useLatestRequest();
  const fetchTxs = useCallback(async () => {
    if (!storeId || !statementId) return;
    const isLatest = beginTxRequest();
    const qs = filter !== 'all' ? `&matchStatus=${filter}` : '';
    // `apiGetPage` keeps the route's `meta`, so the row count is the statement's REAL total and a
    // pager reaches every transaction past the 200-row page (issue 2430).
    const {
      data,
      meta,
      error: err,
    } = await apiGetPage<BankTx>(
      `/api/v1/stores/${storeId}/finance/bank-statements/${statementId}/transactions?perPage=200&page=${txPage}${qs}`
    );
    if (!isLatest()) return;
    if (err) {
      setError(err.message ?? t('errors.loadTransactions'));
      return;
    }
    setTxs(data ?? []);
    setTxMeta(meta);
  }, [storeId, statementId, filter, txPage, beginTxRequest]);

  useEffect(() => {
    fetchStmt();
  }, [fetchStmt, refreshKey]);
  useEffect(() => {
    fetchTxs();
  }, [fetchTxs, refreshKey]);

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
        t('autoMatchResult', {
          matched: String(r.matched),
          unmatched: String(r.unmatched),
          ambiguous: String(r.ambiguous),
        })
      );
    }
    setRefreshKey(k => k + 1);
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
      toastError(err.message ?? t('errors.action'));
      return;
    }
    setRefreshKey(k => k + 1);
  }

  async function handleManualMatch(txId: string, journalEntryId: string) {
    const { error: err } = await apiPatch(
      `/api/v1/stores/${storeId}/finance/bank-statements/${statementId}/transactions/${txId}`,
      { action: 'match', journalEntryId }
    );
    if (err) {
      toastError(err.message ?? t('errors.match'));
      return;
    }
    setRefreshKey(k => k + 1);
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
    <AdminLayout
      title={stmt?.fileName ?? t('title')}
      subtitle={
        stmt
          ? `${stmt.glAccount.code} — ${stmt.glAccount.nameEn}${stmt.periodStart ? ` · ${fmt(stmt.periodStart)} – ${fmt(stmt.periodEnd)}` : ''}`
          : undefined
      }
      parent={{ label: t('title'), href: `/stores/${storeId}/finance/bank-reconciliation` }}
      actions={
        <Button onClick={handleAutoMatch} disabled={autoMatchLoading}>
          {autoMatchLoading ? t('autoMatching') : t('autoMatch')}
        </Button>
      }
    >
      <div className="space-y-6 p-4 md:p-6">
        {autoMatchMsg && (
          <div className="rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm text-info-ink">
            {autoMatchMsg}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive-ink">
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
              {
                label: t('summary.matchedAmount'),
                value: `EGP ${major(summary.matchedAmountFils)}`,
              },
              {
                label: t('summary.unmatchedAmount'),
                value: `EGP ${major(summary.unmatchedAmountFils)}`,
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
              difference.isReconciled
                ? 'border-success/40 bg-card'
                : 'border-destructive/40 bg-card'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">{t('difference.title')}</h2>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  difference.isReconciled
                    ? 'bg-success/10 text-success-ink'
                    : 'bg-destructive/10 text-destructive-ink'
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
                  {difference.bankBalanceFils < 0 ? '−' : ''}
                  {tc('egp')} {major(Math.abs(difference.bankBalanceFils))}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
                <p className="text-xs text-muted-foreground leading-tight">
                  {t('difference.ledgerBalance')}
                </p>
                <p className="mt-1 text-lg font-semibold text-foreground font-mono">
                  {difference.ledgerBalanceFils < 0 ? '−' : ''}
                  {tc('egp')} {major(Math.abs(difference.ledgerBalanceFils))}
                </p>
              </div>
              <div
                className={`rounded-lg border p-3 shadow-sm ${
                  difference.isReconciled
                    ? 'border-success/30 bg-success/10'
                    : 'border-destructive/30 bg-destructive/10'
                }`}
              >
                {/* muted-foreground is 4.35:1 on the light 10% success tint (under
                    AA); the role ink is the measured pair (issue 2381). */}
                <p
                  className={`text-xs leading-tight ${
                    difference.isReconciled ? 'text-success-ink' : 'text-destructive-ink'
                  }`}
                >
                  {t('difference.delta')}
                </p>
                <p
                  className={`mt-1 text-lg font-bold font-mono ${
                    difference.isReconciled ? 'text-success-ink' : 'text-destructive-ink'
                  }`}
                >
                  {difference.differenceFils < 0 ? '−' : difference.differenceFils > 0 ? '+' : ''}
                  {tc('egp')} {major(Math.abs(difference.differenceFils))}
                </p>
              </div>
            </div>

            {/* Where breakdown */}
            {!difference.isReconciled && (
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
                  <p className="text-xs font-medium text-warning-ink">
                    {t('difference.unmatchedBankSide')}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-warning-ink font-mono">
                    {tc('egp')} {major(difference.unmatchedBankFils)}
                  </p>
                  <p className="mt-0.5 text-xs text-warning-ink">
                    {summary?.unmatched ?? 0} {t('difference.bankLines')}
                  </p>
                </div>
                <div className="rounded-lg border border-info/30 bg-info/10 p-3">
                  <p className="text-xs font-medium text-info-ink">
                    {t('difference.unmatchedLedgerSide')}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-info-ink font-mono">
                    {difference.unmatchedLedgerFils < 0 ? '−' : ''}
                    {tc('egp')} {major(Math.abs(difference.unmatchedLedgerFils))}
                  </p>
                  <p className="mt-0.5 text-xs text-info-ink">
                    {difference.unmatchedLedgerCount} {t('difference.ledgerEntries')}
                  </p>
                </div>
              </div>
            )}

            {/* Suggested action */}
            <div
              className={`rounded-lg border p-3 text-sm ${
                difference.isReconciled
                  ? 'border-success/30 bg-success/10 text-success-ink'
                  : 'border-warning/30 bg-warning/10 text-warning-ink'
              }`}
            >
              <p className="font-medium mb-0.5">{t('difference.suggestedAction')}</p>
              <p>{difference.suggestedActionEn}</p>
              <p className="mt-1 text-xs text-right" dir="rtl">
                {difference.suggestedActionAr}
              </p>
            </div>
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-2">
          {FILTER_OPTIONS.map(opt => (
            <Button
              key={opt.value}
              onClick={() => {
                setFilter(opt.value);
                setTxPage(1); // a new filter is a new list
              }}
              variant={filter === opt.value ? 'soft' : 'ghost'}
              size="sm"
            >
              {opt.label}
            </Button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground self-center">
            {tx_t('totalCount', {
              total: (txMeta?.total ?? txs.length).toLocaleString(
                intlLocaleForUi(),
                withNumerals()
              ),
            })}
          </span>
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
                      className="whitespace-nowrap px-3 py-3 text-start text-xs font-medium uppercase tracking-wide text-muted-foreground"
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
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tx.direction === 'debit' ? 'bg-destructive/10 text-destructive-ink' : 'bg-success/10 text-success-ink'}`}
                      >
                        {tx.direction === 'debit' ? tx_t('debit') : tx_t('credit')}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-sm text-foreground">
                      {major(tx.amountFils)}
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
                          <span className="ms-1 opacity-60">{tx.confidence}%</span>
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
                            <Button onClick={() => setMatchModal(tx.id)} variant="ghost" size="sm">
                              {tx_t('match')}
                            </Button>
                            <Button
                              onClick={() => handleAction(tx.id, 'ignore')}
                              disabled={actionLoading === tx.id}
                              variant="ghost"
                              size="sm"
                            >
                              {actionLoading === tx.id ? '…' : tx_t('ignore')}
                            </Button>
                          </>
                        )}
                        {(tx.matchStatus === 'auto_matched' ||
                          tx.matchStatus === 'manual_matched') && (
                          <Button
                            onClick={() => handleAction(tx.id, 'unmatch')}
                            disabled={actionLoading === tx.id}
                            variant="ghost"
                            size="sm"
                          >
                            {actionLoading === tx.id ? '…' : tx_t('unmatch')}
                          </Button>
                        )}
                        {tx.matchStatus === 'ignored' && (
                          <Button
                            onClick={() => handleAction(tx.id, 'unmatch')}
                            disabled={actionLoading === tx.id}
                            variant="ghost"
                            size="sm"
                          >
                            {actionLoading === tx.id ? '…' : tx_t('unmatch')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <PageControls meta={txMeta} onPageChange={setTxPage} />
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
