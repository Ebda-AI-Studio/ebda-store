'use client';

import { STATUS_COLORS } from '@/lib/orders';
import { useLanguage } from '@/contexts/LanguageContext';

export function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  const cls = STATUS_COLORS[status] ?? 'bg-muted text-muted-foreground border-border';
  const label = t.status[status] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}
