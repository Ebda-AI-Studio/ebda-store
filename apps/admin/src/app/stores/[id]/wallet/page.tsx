'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';
import { formatDate, formatPrice } from '../../../../lib/format';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

interface WalletRow {
  id: string;
  customerId: string;
  balance: number;
  updatedAt: string;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
  };
}

interface WalletsResponse {
  wallets: WalletRow[];
  nextCursor: string | null;
  summary: { outstandingTotal: number; walletsWithBalance: number };
  checkout: {
    available: boolean;
    reason: 'feature_off' | 'checkout_feature_off' | null;
  };
}

/**
 * Sales → Wallet (D1): every customer holding store credit, largest balance
 * first, the store's outstanding store-credit total, and whether customers can
 * spend it at checkout (and if not, why). Each row links to the customer page,
 * where the ledger and the Adjust action live.
 */
export default function WalletPage() {
  const { gate } = useRequireFeature('customer_wallet');
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('wallet');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';

  const [data, setData] = useState<WalletsResponse | null>(null);
  const [rows, setRows] = useState<WalletRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    setError(null);
    const { data: res, error: apiError } = await apiGet<WalletsResponse>(
      `/api/v1/stores/${storeId}/wallets`
    );
    if (apiError || !res) {
      setError(t('loadFailed'));
    } else {
      setData(res);
      setRows(res.wallets);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    const { data: res } = await apiGet<WalletsResponse>(
      `/api/v1/stores/${storeId}/wallets?cursor=${encodeURIComponent(data.nextCursor)}`
    );
    if (res) {
      setRows(prev => [...prev, ...res.wallets]);
      setData(prev => (prev ? { ...prev, nextCursor: res.nextCursor } : res));
    }
    setLoadingMore(false);
  }

  if (gate) return gate;

  const money = (piastres: number) => formatPrice(piastres, { locale });
  const checkoutCopy = !data ? null : data.checkout.available ? t('checkoutOn') : t('checkoutOff');

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')}>
      {loading ? (
        <div className="space-y-4">
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
          <div className="h-48 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : error || !data ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive-ink">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={load}>
            {t('retry')}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {t('outstanding')}
              </p>
              <p className="mt-1 text-2xl font-bold text-foreground" dir="ltr">
                {money(data.summary.outstandingTotal)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('outstandingHint')}</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {t('walletsWithBalance')}
              </p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {data.summary.walletsWithBalance}
              </p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  {t('checkoutTitle')}
                </p>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    data.checkout.available
                      ? 'bg-success/10 text-success-ink'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {data.checkout.available ? t('statusOn') : t('statusOff')}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{checkoutCopy}</p>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            {rows.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/20">
                    <tr>
                      <th className="px-4 py-2 text-start text-xs font-medium text-muted-foreground">
                        {t('colCustomer')}
                      </th>
                      <th className="hidden px-4 py-2 text-start text-xs font-medium text-muted-foreground md:table-cell">
                        {t('colContact')}
                      </th>
                      <th className="px-4 py-2 text-end text-xs font-medium text-muted-foreground">
                        {t('colBalance')}
                      </th>
                      <th className="hidden px-4 py-2 text-end text-xs font-medium text-muted-foreground sm:table-cell">
                        {t('colUpdated')}
                      </th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map(row => (
                      <tr key={row.id}>
                        <td className="px-4 py-2 font-medium text-foreground">
                          {`${row.customer.firstName} ${row.customer.lastName}`.trim() || '—'}
                        </td>
                        <td
                          className="hidden px-4 py-2 text-muted-foreground md:table-cell"
                          dir="ltr"
                        >
                          {row.customer.phone || row.customer.email || '—'}
                        </td>
                        <td className="px-4 py-2 text-end font-semibold text-foreground" dir="ltr">
                          {money(row.balance)}
                        </td>
                        <td className="hidden px-4 py-2 text-end text-muted-foreground sm:table-cell">
                          {formatDate(row.updatedAt)}
                        </td>
                        <td className="px-4 py-2 text-end">
                          <Link
                            href={`/stores/${storeId}/customers/${encodeURIComponent(row.customerId)}`}
                            className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                          >
                            {t('view')}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.nextCursor && (
                  <div className="border-t p-3 text-center">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={loadMore}
                      isLoading={loadingMore}
                    >
                      {t('loadMore')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
