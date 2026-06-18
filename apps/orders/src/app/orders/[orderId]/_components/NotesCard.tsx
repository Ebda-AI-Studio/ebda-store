'use client';

import { useLanguage } from '@/contexts/LanguageContext';
import type { OrderDetail } from '@/lib/orders';

interface NotesCardProps {
  order: OrderDetail;
}

/** Notes card — mirrors the admin NotesCard. Customer + internal notes. */
export function NotesCard({ order }: NotesCardProps) {
  const { t } = useLanguage();
  if (!order.customerNotes && !order.notes) return null;

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4">
      {order.customerNotes && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t.detail.customerNotes}
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {order.customerNotes}
          </p>
        </div>
      )}
      {order.notes && (
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t.detail.notes}
          </h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {order.notes}
          </p>
        </div>
      )}
    </section>
  );
}
