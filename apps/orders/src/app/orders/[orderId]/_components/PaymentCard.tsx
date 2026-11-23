'use client';

import { orderPaymentSummary } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatMoney, fmt } from '@/lib/format';
import type { OrderDetail } from '@/lib/orders';

interface PaymentCardProps {
  order: OrderDetail;
}

/**
 * Payment summary card — mirrors the admin PaymentCard. Shows paid/unpaid
 * state, total, remaining (when unpaid), the provider/method + transaction id
 * from the latest payment attempt, and a link to the provider's hosted page if
 * one was issued. The admin's per-payment PaymentEventsTimeline (super-admin
 * raw-payload tool) is intentionally omitted — the PWA is a staff tool and that
 * deep diagnostic isn't part of the staff flow.
 */
export function PaymentCard({ order }: PaymentCardProps) {
  const { t } = useLanguage();
  // paid / refunded / unpaid. A refunded order is NOT unpaid: nothing is owed on it.
  const { state, refunded, remain } = orderPaymentSummary(order);
  const isUnpaid = state === 'unpaid';
  const link = order.payments?.find(p => p.paymentLink)?.paymentLink ?? null;

  const detailPayment =
    order.payments?.find(p => p.status === 'completed') ??
    [...(order.payments ?? [])].sort(
      (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
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
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {t.detail.payment}
      </h2>

      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            isUnpaid ? 'bg-destructive/10 text-destructive-ink' : 'bg-success/10 text-success-ink'
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="font-semibold text-foreground">
              {state === 'refunded'
                ? t.detail.refunded
                : state === 'paid'
                  ? t.detail.paid
                  : t.detail.unpaid}
            </div>
            <div className="font-semibold text-foreground">
              {formatMoney(order.total, order.currency)}
            </div>
          </div>
          {isUnpaid && (
            <div className="mt-1 text-end text-sm text-muted-foreground">
              {fmt(t.detail.remain, { amount: formatMoney(remain, order.currency) })}
            </div>
          )}
          {!isUnpaid && refunded > 0 && (
            <div className="mt-1 text-end text-sm text-muted-foreground">
              {fmt(t.detail.refundedAmount, { amount: formatMoney(refunded, order.currency) })}
            </div>
          )}

          {providerLabel && (
            <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
              {order.status === 'awaiting_payment_confirmation' && (
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <dt className="text-muted-foreground">{t.instapay.reference}</dt>
                  <dd className="font-medium text-foreground" dir="ltr">
                    {order.instapay?.customerReference ?? t.instapay.waiting}
                  </dd>
                </div>
              )}
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t.detail.paymentMethod}</dt>
                <dd className="font-medium text-foreground">{providerLabel}</dd>
              </div>
              {detailPayment?.transactionId && (
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{t.detail.paymentTransactionId}</dt>
                  <dd className="break-all text-end font-mono text-xs text-foreground">
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
              className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary underline"
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
              {t.detail.paymentLink}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
