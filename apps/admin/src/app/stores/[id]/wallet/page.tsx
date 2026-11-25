'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';
import { DataTable } from '../../../../components/mobile/DataTable';
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
          <div className="h-24 animate-pulse rounded-md bg-muted" />
          <div className="h-48 animate-pulse rounded-md bg-muted" />
        </div>
      ) : error || !data ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive-ink">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={load}>
            {t('retry')}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-md border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {t('outstanding')}
              </p>
              <p className="mt-1 text-2xl font-bold text-foreground" dir="ltr">
                {money(data.summary.outstandingTotal)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('outstandingHint')}</p>
            </div>
            <div className="rounded-md border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {t('walletsWithBalance')}
              </p>
              <p className="mt-1 text-2xl font-bold text-foreground">
                {data.summary.walletsWithBalance}
              </p>
            </div>
            <div className="rounded-md border bg-card p-4">
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
              {!data.checkout.available && (
                <Link
                  href={`/stores/${storeId}/billing/addons`}
                  className="mt-1 inline-block text-xs font-medium text-primary underline"
                >
                  {t('checkoutOffCta')}
                </Link>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-md border bg-card shadow-sm">
            {rows.length === 0 ? (
              <div className="flex flex-col items-start gap-3 p-6">
                <p className="text-sm text-muted-foreground">{t('empty')}</p>
                <Link href={`/stores/${storeId}/customers`} className={buttonVariants()}>
                  {t('emptyAction')}
                </Link>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <DataTable
                  ariaLabel={t('colCustomer')}
                  rows={rows}
                  rowKey={row => row.id}
                  columns={[
                    {
                      header: t('colCustomer'),
                      primaryOnMobile: true,
                      cell: row => (
                        <span className="font-medium text-foreground">
                          {`${row.customer.firstName} ${row.customer.lastName}`.trim() || '—'}
                        </span>
                      ),
                    },
                    {
                      header: t('colContact'),
                      cell: row => (
                        <span className="text-muted-foreground" dir="ltr">
                          {row.customer.phone || row.customer.email || '—'}
                        </span>
                      ),
                    },
                    {
                      header: t('colBalance'),
                      alignEnd: true,
                      cell: row => (
                        <span className="font-semibold text-foreground" dir="ltr">
                          {money(row.balance)}
                        </span>
                      ),
                    },
                    {
                      header: t('colUpdated'),
                      alignEnd: true,
                      cell: row => (
                        <span className="text-muted-foreground">{formatDate(row.updatedAt)}</span>
                      ),
                    },
                    {
                      header: '',
                      mobileActions: true,
                      alignEnd: true,
                      cell: row => (
                        <Link
                          href={`/stores/${storeId}/customers/${encodeURIComponent(row.customerId)}`}
                          className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        >
                          {t('view')}
                        </Link>
                      ),
                    },
                  ]}
                />
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
