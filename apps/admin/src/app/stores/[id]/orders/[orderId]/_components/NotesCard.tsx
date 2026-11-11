'use client';

import { useT } from '@/i18n/useT';
import type { OrderDetail } from './types';

interface NotesCardProps {
  order: OrderDetail;
}

export function NotesCard({ order }: NotesCardProps) {
  const t = useT('orders.detail');
  if (!order.customerNotes && !order.notes) return null;

  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
      {order.customerNotes && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-2">
            {t('customerNotes')}
          </h3>
          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {order.customerNotes}
          </p>
        </div>
      )}
      {order.notes && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-2">
            {t('notes')}
          </h3>
          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {order.notes}
          </p>
        </div>
      )}
    </section>
  );
}
