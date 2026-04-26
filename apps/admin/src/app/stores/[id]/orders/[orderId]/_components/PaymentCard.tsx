'use client';

import { useT } from '@/i18n/useT';
import { formatMoney } from './format';
import type { OrderDetail } from './types';

interface PaymentCardProps {
  order: OrderDetail;
  onEdit?: () => void;
}

export function PaymentCard({ order, onEdit }: PaymentCardProps) {
  const t = useT('orders.detail');
  const isPaid = order.paymentStatus === 'paid';
  const remain = isPaid ? 0 : order.total;
  const link = order.payments?.find(p => p.paymentLink)?.paymentLink ?? null;

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
        </div>
      </div>
    </section>
  );
}
