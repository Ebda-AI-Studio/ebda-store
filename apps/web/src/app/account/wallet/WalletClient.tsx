'use client';

import { storeNumerals } from '@ebda/shared';
import { useEffect, useState } from 'react';
import { useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useLocalePrice } from '../../../hooks/useLocalePrice';
import { useWallet } from '../../../hooks/useWallet';
import { api } from '../../../lib/api';
import { formatDate as formatStoreDate } from '../../../lib/format-date';
import { SignedNumber } from '@ebda/ui';

interface WalletEntry {
  id: string;
  amount: number;
  balanceAfter: number;
  type: string;
  createdAt: string;
  order: { orderNumber: string } | null;
  return: { returnNumber: string } | null;
}

/**
 * /account/wallet — the shopper's store-credit balance and history (D1).
 * Everything the shopper reads goes through LanguageContext `t(en, ar)`.
 * Renders the "not available" state unless the API itself confirms the
 * wallet for this store (useWallet), so a store without the feature never
 * shows a balance.
 */
export default function WalletClient() {
  const { store } = useStore();
  const { t, language } = useLanguage();
  const money = useLocalePrice();
  const { wallet, isLoading: walletLoading } = useWallet();
  const storeId = store.id;

  const [rows, setRows] = useState<WalletEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const formatDate = (iso: string) =>
    formatStoreDate(iso, {
      timezone: store.timezone,
      language,
      numerals: storeNumerals(store?.theme),
      style: 'long',
    });

  useEffect(() => {
    if (!wallet || !storeId) {
      setHistoryLoading(false);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(false);
    api
      .getWalletTransactions(storeId)
      .then(res => {
        if (cancelled) return;
        if (res.success && res.data) {
          setRows(res.data.transactions);
          setNextCursor(res.data.nextCursor);
        } else {
          setHistoryError(true);
        }
      })
      .catch(() => !cancelled && setHistoryError(true))
      .finally(() => !cancelled && setHistoryLoading(false));
    return () => {
      cancelled = true;
    };
  }, [wallet, storeId]);

  async function loadMore() {
    if (!nextCursor || !storeId) return;
    setLoadingMore(true);
    const res = await api.getWalletTransactions(storeId, nextCursor);
    if (res.success && res.data) {
      setRows(prev => [...prev, ...res.data!.transactions]);
      setNextCursor(res.data.nextCursor);
    }
    setLoadingMore(false);
  }

  function describe(entry: WalletEntry): string {
    switch (entry.type) {
      case 'refund_credit':
        return t('Refund as store credit', 'استرداد كرصيد متجر');
      case 'order_payment':
        return t('Paid for an order', 'دفع لطلب');
      case 'order_payment_reversal':
        return t('Order payment returned', 'إرجاع دفعة طلب');
      case 'admin_adjust':
        return entry.amount > 0
          ? t('Credit added by the store', 'رصيد أضافه المتجر')
          : t('Deducted by the store', 'خصم من المتجر');
      case 'expire':
        return t('Balance written off', 'رصيد مشطوب');
      case 'debit':
        return t('Deduction', 'خصم');
      default:
        return t('Credit', 'إضافة رصيد');
    }
  }

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-foreground">{t('Wallet', 'المحفظة')}</h1>
      <p className="mt-1 text-muted-foreground">
        {t(
          'Store credit you can spend on your next orders.',
          'رصيد المتجر اللي تقدر تستخدمه في طلباتك الجاية.'
        )}
      </p>
    </div>
  );

  if (walletLoading) {
    return (
      <div className="space-y-6">
        {header}
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (!wallet) {
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-xl border bg-card p-8 text-center shadow-sm">
          <p className="text-muted-foreground">
            {t('This store does not offer a wallet.', 'المتجر ده مش بيقدم خدمة المحفظة.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {t('Available balance', 'الرصيد المتاح')}
        </p>
        <p className="mt-1 text-3xl font-bold text-foreground">{money(wallet.balance)}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {wallet.checkoutAvailable
            ? t(
                'You can use it at checkout — choose “Use wallet balance”.',
                'تقدر تستخدمه وقت الدفع — اختار «استخدام رصيد المحفظة».'
              )
            : t(
                'Refunds issued as store credit are added here.',
                'المبالغ المستردة بتتضاف هنا كرصيد متجر.'
              )}
        </p>
      </div>

      <div className="rounded-xl border bg-card shadow-sm">
        <h2 className="border-b px-5 py-3 text-sm font-semibold text-foreground">
          {t('History', 'السجل')}
        </h2>
        {historyLoading ? (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : historyError ? (
          <p className="px-5 py-6 text-sm text-destructive-ink">
            {t(
              'Could not load your wallet history. Please try again.',
              'معرفناش نحمّل سجل المحفظة. جرّب تاني.'
            )}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {t('No wallet activity yet.', 'مفيش حركات في المحفظة لسه.')}
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map(entry => (
              <li key={entry.id} className="flex items-start justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{describe(entry)}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(entry.createdAt)}
                    {entry.order && (
                      <>
                        {' · '}
                        {t('Order', 'طلب')} <span dir="ltr">{entry.order.orderNumber}</span>
                      </>
                    )}
                    {!entry.order && entry.return && (
                      <>
                        {' · '}
                        {t('Return', 'مرتجع')} <span dir="ltr">{entry.return.returnNumber}</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  <p
                    className={`text-sm font-semibold ${
                      entry.amount > 0 ? 'text-success-ink' : 'text-foreground'
                    }`}
                  >
                    <span dir="ltr">
                      <SignedNumber value={entry.amount} plus format={abs => money(abs)} />
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('Balance', 'الرصيد')} {money(entry.balanceAfter)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextCursor && !historyLoading && (
          <div className="border-t p-3 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded-lg border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {loadingMore ? t('Loading…', 'بنحمّل…') : t('Load more', 'تحميل المزيد')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
