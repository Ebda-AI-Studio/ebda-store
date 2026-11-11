'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { formatDateTime, formatPrice } from '@/lib/format';
import { WalletAdjustModal } from './WalletAdjustModal';
import { formatSigned } from '@ebda/shared';

export interface WalletEntryRow {
  id: string;
  amount: number;
  balanceAfter: number;
  type:
    | 'credit'
    | 'debit'
    | 'refund_credit'
    | 'order_payment'
    | 'order_payment_reversal'
    | 'admin_adjust'
    | 'expire';
  note: string | null;
  /** The balance written off when the customer deleted their account (issue 2126). */
  erasureWriteOff?: boolean;
  createdAt: string;
  order: { id: string; orderNumber: string } | null;
  return: { id: string; returnNumber: string } | null;
}

interface WalletPage {
  balance: number;
  transactions: WalletEntryRow[];
  nextCursor: string | null;
}

interface CustomerWalletCardProps {
  storeId: string;
  customerId: string;
  /** Owner/admin may adjust; the API enforces the same (store_admin/super_admin). */
  canAdjust: boolean;
  /** Reports the balance up so the privacy card can warn before erasure. */
  onBalance?: (balance: number) => void;
}

/**
 * Customer wallet (store credit, D1) on the customer detail page: balance,
 * the full ledger (newest first, "load more"), and the manual Adjust action.
 * Rendered only when the store has `customer_wallet` on (the parent gates it).
 */
export function CustomerWalletCard({
  storeId,
  customerId,
  canAdjust,
  onBalance,
}: CustomerWalletCardProps) {
  const t = useT('customers.detail.wallet');
  const tDetail = useT('customers.detail');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [balance, setBalance] = useState<number | null>(null);
  const [rows, setRows] = useState<WalletEntryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const base = `/api/v1/stores/${storeId}/customers/${customerId}/wallet`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: apiError } = await apiGet<WalletPage>(base);
    if (apiError || !data) {
      setError(t('loadFailed'));
    } else {
      setBalance(data.balance);
      setRows(data.transactions);
      setNextCursor(data.nextCursor);
      onBalance?.(data.balance);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    const { data } = await apiGet<WalletPage>(`${base}?cursor=${encodeURIComponent(nextCursor)}`);
    if (data) {
      setRows(prev => [...prev, ...data.transactions]);
      setNextCursor(data.nextCursor);
    }
    setLoadingMore(false);
  }

  const money = (piastres: number) => formatPrice(piastres, { locale });

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="flex flex-col gap-3 border-b bg-muted/40 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-end">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{t('balance')}</p>
            <p className="text-xl font-bold text-foreground" dir="ltr">
              {balance === null ? '—' : money(balance)}
            </p>
          </div>
          {canAdjust && balance !== null && (
            <Button type="button" variant="outline" onClick={() => setAdjustOpen(true)}>
              {t('adjust')}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="h-24 animate-pulse bg-muted/30" />
      ) : error ? (
        <div className="p-4 text-sm text-destructive-ink">
          {error}
          <button type="button" className="ms-3 font-medium underline" onClick={load}>
            {tDetail('retry')}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/20">
              <tr>
                <th className="px-4 py-2 text-start text-xs font-medium text-muted-foreground">
                  {t('colDate')}
                </th>
                <th className="px-4 py-2 text-start text-xs font-medium text-muted-foreground">
                  {t('colType')}
                </th>
                <th className="px-4 py-2 text-start text-xs font-medium text-muted-foreground hidden md:table-cell">
                  {t('colReference')}
                </th>
                <th className="px-4 py-2 text-end text-xs font-medium text-muted-foreground">
                  {t('colAmount')}
                </th>
                <th className="px-4 py-2 text-end text-xs font-medium text-muted-foreground hidden sm:table-cell">
                  {t('colBalance')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(row => (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-foreground">
                    {t(`types.${row.type}`)}
                    {row.erasureWriteOff ? (
                      <p className="mt-0.5 text-xs text-muted-foreground break-words">
                        {t('erasureWriteOff')}
                      </p>
                    ) : (
                      row.note && (
                        <p className="mt-0.5 text-xs text-muted-foreground break-words">
                          {row.note}
                        </p>
                      )
                    )}
                  </td>
                  <td className="px-4 py-2 hidden md:table-cell">
                    {row.order ? (
                      <Link
                        href={`/stores/${storeId}/orders/${row.order.id}`}
                        className="text-primary hover:underline"
                      >
                        {t('refOrder', { number: row.order.orderNumber })}
                      </Link>
                    ) : row.return ? (
                      <span className="text-muted-foreground">
                        {t('refReturn', { number: row.return.returnNumber })}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td
                    className={`px-4 py-2 text-end font-medium whitespace-nowrap ${
                      row.amount > 0 ? 'text-success-ink' : 'text-destructive-ink'
                    }`}
                    dir="ltr"
                  >
                    {formatSigned(row.amount, { plus: true, format: abs => money(abs) })}
                  </td>
                  <td
                    className="px-4 py-2 text-end text-muted-foreground whitespace-nowrap hidden sm:table-cell"
                    dir="ltr"
                  >
                    {money(row.balanceAfter)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="border-t p-3 text-center">
              <Button type="button" variant="outline" onClick={loadMore} isLoading={loadingMore}>
                {t('loadMore')}
              </Button>
            </div>
          )}
        </div>
      )}

      {canAdjust && balance !== null && (
        <WalletAdjustModal
          open={adjustOpen}
          storeId={storeId}
          customerId={customerId}
          balance={balance}
          onClose={() => setAdjustOpen(false)}
          onAdjusted={() => {
            load();
          }}
        />
      )}
    </div>
  );
}
