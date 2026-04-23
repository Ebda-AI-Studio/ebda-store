'use client';

import { useT } from '@/i18n/useT';

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const t = useT('products.list.status');
  const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium';
  switch (status) {
    case 'active':
      return (
        <span
          className={`${base} bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {t('active')}
        </span>
      );
    case 'draft':
      return (
        <span
          className={`${base} bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          {t('draft')}
        </span>
      );
    case 'archived':
      return (
        <span className={`${base} bg-muted text-muted-foreground`}>
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          {t('archived')}
        </span>
      );
    default:
      return (
        <span className={`${base} bg-muted text-muted-foreground`}>
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
          {status}
        </span>
      );
  }
}
