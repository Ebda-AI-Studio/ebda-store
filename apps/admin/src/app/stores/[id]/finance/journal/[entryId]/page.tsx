'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PageState } from '@/components/PageState';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { minorToMajor } from '@/lib/format';
import { withNumerals } from '@ebda/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LineAccount {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
}

interface JournalLine {
  id: string;
  debit: number;
  credit: number;
  lineMemo: string | null;
  account: LineAccount;
}

interface ReversalRef {
  id: string;
  entryNumber: string;
}

interface JournalEntry {
  id: string;
  entryNumber: string;
  postedAt: string;
  source: string;
  memo: string | null;
  memoAr: string | null;
  status: 'posted' | 'reversed' | 'draft';
  /** Entry that reversed this one (this entry is the original). */
  reversedBy: ReversalRef | null;
  /** Entry that this one reverses (this entry is the reversal). */
  reverses: ReversalRef | null;
  lines: JournalLine[];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function JournalDetailPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const entryId = params?.entryId as string;
  const t = useT('finance.journal');

  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId || !entryId) return;
    apiGet<JournalEntry>(`/api/v1/stores/${storeId}/finance/journal/${entryId}`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (data) {
          setEntry(data);
        } else {
          setError(t('entryNotFound'));
        }
      })
      .catch(() => setError(t('loadEntryFailed')));
  }, [storeId, entryId, retryKey]);

  const backHref = `/stores/${storeId}/finance/journal`;

  if (error || !entry) {
    return (
      <AdminLayout title={t('title')} parent={{ label: t('title'), href: backHref }}>
        <PageState loading={!error} error={error} onRetry={() => setRetryKey(k => k + 1)}>
          {null}
        </PageState>
      </AdminLayout>
    );
  }

  const totalDr = entry.lines.reduce((s, l) => s + l.debit, 0);
  const totalCr = entry.lines.reduce((s, l) => s + l.credit, 0);

  return (
    <AdminLayout
      parent={{ label: t('title'), href: backHref }}
      title={entry.entryNumber}
      subtitle={`${new Date(entry.postedAt).toLocaleString(undefined, withNumerals())} · ${entry.source.replace(/_/g, ' ')}`}
    >
      <div className="max-w-3xl space-y-5">
        {/* Entry header card */}
        <div className="rounded-xl border border-border bg-card p-5 space-y-2">
          {entry.memo && <p className="text-sm text-foreground">{entry.memo}</p>}
          {entry.memoAr && (
            <p className="text-sm text-muted-foreground" dir="rtl">
              {entry.memoAr}
            </p>
          )}

          {/* Reversal notices */}
          {entry.status === 'reversed' && entry.reversedBy && (
            <p className="text-sm text-warning-ink">
              {t('reversed')}{' '}
              <Link
                href={`/stores/${storeId}/finance/journal/${entry.reversedBy.id}`}
                className="underline underline-offset-2"
              >
                {entry.reversedBy.entryNumber}
              </Link>
            </p>
          )}
          {entry.reverses && (
            <p className="text-sm text-warning-ink">
              {t('reverses')}{' '}
              <Link
                href={`/stores/${storeId}/finance/journal/${entry.reverses.id}`}
                className="underline underline-offset-2"
              >
                {entry.reverses.entryNumber}
              </Link>
            </p>
          )}
        </div>

        {/* Lines table — genuine accounting ledger (debit/credit columns are
            the point); kept as an isolated horizontal-scroll container per
            the B1 mobile-table exception rather than card-stacked. */}
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-start px-3 py-2 font-medium text-muted-foreground w-24">
                  {t('account')}
                </th>
                <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                  {t('memo')}
                </th>
                <th className="text-end px-3 py-2 font-medium text-muted-foreground w-32">
                  {t('debit')}
                </th>
                <th className="text-end px-3 py-2 font-medium text-muted-foreground w-32">
                  {t('credit')}
                </th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map(line => (
                <tr key={line.id} className="border-t border-border/40">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {line.account.code}
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-foreground">{line.lineMemo ?? line.account.nameEn}</span>
                    {line.account.nameAr && !line.lineMemo && (
                      <span className="text-muted-foreground text-xs ms-2" dir="rtl">
                        — {line.account.nameAr}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-end font-mono text-xs">
                    {line.debit > 0 ? minorToMajor(line.debit) : ''}
                  </td>
                  <td className="px-3 py-2 text-end font-mono text-xs">
                    {line.credit > 0 ? minorToMajor(line.credit) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
            {/* Totals footer */}
            <tfoot className="bg-muted/20 border-t border-border">
              <tr>
                <td className="px-3 py-2 text-xs font-medium text-muted-foreground" colSpan={2}>
                  {t('totalLabel')}
                </td>
                <td className="px-3 py-2 text-end font-mono text-xs font-semibold">
                  {minorToMajor(totalDr)}
                </td>
                <td className="px-3 py-2 text-end font-mono text-xs font-semibold">
                  {minorToMajor(totalCr)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
