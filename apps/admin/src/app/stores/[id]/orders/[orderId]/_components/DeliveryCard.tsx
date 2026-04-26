'use client';

import { useT } from '@/i18n/useT';
import { formatAddressLines, formatDateTime } from './format';
import type { OrderDetail } from './types';

interface DeliveryCardProps {
  order: OrderDetail;
  locale: string;
  onEdit?: () => void;
}

export function DeliveryCard({ order, locale, onEdit }: DeliveryCardProps) {
  const t = useT('orders.detail');
  const lines = formatAddressLines(order.shippingAddress);

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('delivery')}
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
            {t('editDeliveryStatus')}
          </button>
        )}
      </div>

      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
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
              d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-foreground mb-2">{t('delivery')}</div>
          {lines.length > 0 ? (
            <>
              <div className="text-sm text-muted-foreground mb-1">{t('deliverTo')}:</div>
              <div className="text-sm text-foreground space-y-0.5">
                {lines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">—</div>
          )}

          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground shrink-0">{t('deliverBy')}:</dt>
              <dd className="text-foreground font-medium">{t('selfShipping')}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground shrink-0">{t('deliverAt')}:</dt>
              <dd className="text-foreground font-medium">
                {formatDateTime(order.shippedAt ?? order.createdAt, locale)}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
