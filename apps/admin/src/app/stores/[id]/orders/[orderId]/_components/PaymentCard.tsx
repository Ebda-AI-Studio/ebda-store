'use client';

import { useT } from '@/i18n/useT';
import { PaymentEventsTimeline } from '../../../../../../components/payment-events/PaymentEventsTimeline';
import { formatMoney } from './format';
import type { OrderDetail } from './types';

interface PaymentCardProps {
  order: OrderDetail;
  onEdit?: () => void;
  /** Viewer role — used to gate the super-admin raw-payload button on the timeline. */
  userRole?: 'super_admin' | 'store_admin' | 'customer' | 'staff';
}

export function PaymentCard({ order, onEdit, userRole }: PaymentCardProps) {
  const t = useT('orders.detail');
  const isPaid = order.paymentStatus === 'paid';
  const remain = isPaid ? 0 : order.total;
  const link = order.payments?.find(p => p.paymentLink)?.paymentLink ?? null;

  // Pick the most-recent successful payment for the details row, falling
  // back to the most recent attempt of any status. Shows the merchant
  // exactly which provider/method was used and the gateway's transaction
  // id so they can reconcile against the gateway dashboard.
  const detailPayment =
    order.payments?.find(p => p.status === 'completed') ??
    [...(order.payments ?? [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0] ??
    null;
  const providerLabel = (() => {
    if (!detailPayment) return null;
    const provider = detailPayment.provider?.trim();
    const method = detailPayment.method?.trim();
    if (!provider) return null;
    if (method && method.toLowerCase() !== provider.toLowerCase()) {
      return `${provider} · ${method}`;
    }
    return provider;
  })();

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('payment')}
        </h2>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline cursor-pointer"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
            {t('editPayment')}
          </button>
        )}
      </div>

      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            isPaid ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
          }`}
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 10h18M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="font-semibold text-foreground">{isPaid ? t('paid') : t('unpaid')}</div>
            <div className="font-semibold text-foreground">
              {formatMoney(order.total, order.currency)}
            </div>
          </div>
          {!isPaid && (
            <div className="mt-1 text-sm text-muted-foreground text-end">
              {t('remain', { amount: formatMoney(remain, order.currency) })}
            </div>
          )}

          {/* Payment details — provider/method + transaction id from the
              latest payment attempt. Hidden when no payment record yet so
              orders that are still waiting on checkout don't show an
              empty section. */}
          {providerLabel && (
            <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <dt className="text-muted-foreground">{t('paymentMethod')}</dt>
                <dd className="font-medium text-foreground">{providerLabel}</dd>
              </div>
              {detailPayment?.transactionId && (
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <dt className="text-muted-foreground">{t('paymentTransactionId')}</dt>
                  <dd className="font-mono text-xs text-foreground break-all text-end">
                    {detailPayment.transactionId}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.828 10.172a4 4 0 015.656 0l1.414 1.414a4 4 0 010 5.656l-2.829 2.829a4 4 0 01-5.656 0L11 18.243M10.172 13.828a4 4 0 01-5.656 0L3.1 12.414a4 4 0 010-5.656l2.829-2.829a4 4 0 015.656 0L13 5.757"
                />
              </svg>
              {t('paymentLink')}
            </a>
          )}

          {/* Payment events lifecycle log — one timeline per payment row.
              Only shown to admin viewers (store_admin or super_admin).
              Lazy-fetches on first expand so the order detail page load
              is not affected when the user never opens the toggle. */}
          {order.payments?.map(p => (
            <PaymentEventsTimeline key={p.id} paymentId={p.id} userRole={userRole} />
          ))}
        </div>
      </div>
    </section>
  );
}
