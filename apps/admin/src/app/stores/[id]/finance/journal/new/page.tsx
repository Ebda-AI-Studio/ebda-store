'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { FormFooter } from '@/components/FormFooter';
import { AdminLayout } from '../../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { minorToMajor } from '@/lib/format';

import { roundToMinor } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
}

interface AccountsTree {
  assets: AccountRow[];
  liabilities: AccountRow[];
  equity: AccountRow[];
  revenue: AccountRow[];
  expenses: AccountRow[];
}

interface LineDraft {
  accountId: string;
  debit: string;
  credit: string;
  lineMemo: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EMPTY_LINE: LineDraft = { accountId: '', debit: '', credit: '', lineMemo: '' };

// ─── Component ────────────────────────────────────────────────────────────────

export default function NewJournalEntryPage() {
  const tc = useT('common');
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('finance.journal');
  const tNew = useT('finance.newEntry');
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin' || user?.role === 'store_admin';

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [memo, setMemo] = useState('');
  const [memoAr, setMemoAr] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<AccountsTree>(`/api/v1/stores/${storeId}/finance/accounts`).then(({ data }) => {
      if (!data) return;
      const flat = [
        ...(data.assets ?? []),
        ...(data.liabilities ?? []),
        ...(data.equity ?? []),
        ...(data.revenue ?? []),
        ...(data.expenses ?? []),
      ].sort((a, b) => a.code.localeCompare(b.code));
      setAccounts(flat);
    });
  }, [storeId]);

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines(cur => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines(cur => [...cur, { ...EMPTY_LINE }]);
  }

  function removeLine(i: number) {
    setLines(cur => (cur.length <= 2 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  // Totals computed in piastres for balance check; user types EGP (3 dp)
  const totals = lines.reduce(
    (acc, l) => ({
      debit: acc.debit + roundToMinor(parseFloat(l.debit) || 0),
      credit: acc.credit + roundToMinor(parseFloat(l.credit) || 0),
    }),
    { debit: 0, credit: 0 }
  );
  const balanced = totals.debit > 0 && totals.debit === totals.credit;

  async function submit() {
    setError(null);
    if (!balanced) {
      setError(tNew('errors.unbalanced'));
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        memo: memo || undefined,
        memoAr: memoAr || undefined,
        lines: lines.map(l => ({
          accountId: l.accountId,
          debit: roundToMinor(parseFloat(l.debit) || 0),
          credit: roundToMinor(parseFloat(l.credit) || 0),
          lineMemo: l.lineMemo || undefined,
        })),
      };
      const { data, error: apiError } = await apiPost<{ id: string }>(
        `/api/v1/stores/${storeId}/finance/journal`,
        payload
      );
      if (apiError) {
        setError(apiError.message);
        return;
      }
      // invalidate App Router cache so the destination list re-fetches the saved row
      router.refresh();
      router.push(`/stores/${storeId}/finance/journal/${data?.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // store_admin and super_admin can post manual journal entries (API: authorize('store_admin', 'super_admin'), ACCT-AUDIT-9).
  // Anyone else gets a clear permission notice instead of a cryptic 403.
  if (!isSuperAdmin) {
    return (
      <AdminLayout title={tNew('title')} subtitle={tNew('description')}>
        <div className="max-w-4xl">
          <div className="rounded-md border border-warning/30 bg-warning/10 p-6 text-sm text-warning-ink">
            <p className="font-semibold mb-1">{tNew('superAdminOnly')}</p>
            <p>{tNew('superAdminNotice')}</p>
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={tNew('title')} subtitle={tNew('description')}>
      <div className="max-w-4xl space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium">{tNew('memo')}</span>
            <input
              type="text"
              value={memo}
              onChange={e => setMemo(e.target.value)}
              className={FIELD_CLASSES}
              placeholder={tNew('memoPlaceholder')}
            />
          </label>
          <label className="space-y-1" dir="rtl">
            <span className="text-sm font-medium">{tNew('memoAr')}</span>
            <input
              type="text"
              value={memoAr}
              onChange={e => setMemoAr(e.target.value)}
              className={FIELD_CLASSES}
              placeholder={tNew('memoArPlaceholder')}
            />
          </label>
        </div>

        {/* Debit/credit line grid — genuine accounting ledger (columns are
            the point); kept as an isolated horizontal-scroll container per
            the B1 mobile-table exception rather than card-stacked. */}
        <div className="rounded-md border border-border overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                  {tNew('account')}
                </th>
                <th className="text-end px-3 py-2 w-32 font-medium text-muted-foreground">
                  {t('debit')} {tc('egpParen')}
                </th>
                <th className="text-end px-3 py-2 w-32 font-medium text-muted-foreground">
                  {t('credit')} {tc('egpParen')}
                </th>
                <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                  {t('memo')}
                </th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-border/40">
                  <td className="px-3 py-2">
                    <select
                      value={l.accountId}
                      onChange={e => updateLine(i, { accountId: e.target.value })}
                      className={FIELD_CLASSES}
                    >
                      <option value="">— {tNew('selectAccount')} —</option>
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.nameEn}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.debit}
                      onChange={e =>
                        updateLine(i, {
                          debit: e.target.value,
                          credit: e.target.value ? '' : l.credit,
                        })
                      }
                      className={`${FIELD_CLASSES} text-end font-mono`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.credit}
                      onChange={e =>
                        updateLine(i, {
                          credit: e.target.value,
                          debit: e.target.value ? '' : l.debit,
                        })
                      }
                      className={`${FIELD_CLASSES} text-end font-mono`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={l.lineMemo}
                      onChange={e => updateLine(i, { lineMemo: e.target.value })}
                      className={FIELD_CLASSES}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Button
                      type="button"
                      onClick={() => removeLine(i)}
                      disabled={lines.length <= 2}
                      variant="link"
                      size="sm"
                      className="text-destructive-ink"
                    >
                      ✕
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/20">
              <tr className="border-t border-border">
                <td className="px-3 py-2 font-medium">{tNew('totals')}</td>
                <td className="px-3 py-2 text-end font-mono font-semibold">
                  {minorToMajor(totals.debit)}
                </td>
                <td className="px-3 py-2 text-end font-mono font-semibold">
                  {minorToMajor(totals.credit)}
                </td>
                <td className="px-3 py-2" colSpan={2}>
                  {!balanced && totals.debit + totals.credit > 0 && (
                    <span className="text-destructive-ink text-xs">
                      {tNew('errors.unbalanced')}
                    </span>
                  )}
                  {balanced && <span className="text-success-ink text-xs">{tNew('balanced')}</span>}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex gap-2">
          <Button type="button" onClick={addLine} variant="outline" size="sm">
            {tNew('addLine')}
          </Button>
        </div>

        {error && (
          <div role="alert" className="text-destructive-ink text-sm">
            {error}
          </div>
        )}

        <p className="text-xs text-muted-foreground">{tNew('superAdminNotice')}</p>

        <FormFooter
          primaryLabel={tNew('submit')}
          cancelHref={`/stores/${storeId}/finance/journal`}
          onPrimary={submit}
          saving={submitting}
          disabled={!balanced}
        />
      </div>
    </AdminLayout>
  );
}
