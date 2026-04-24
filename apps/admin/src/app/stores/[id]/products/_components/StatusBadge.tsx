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
        <span className={`${base} bg-success/10 text-success dark:bg-success/20 dark:text-success`}>
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {t('active')}
        </span>
      );
    case 'draft':
      return (
        <span className={`${base} bg-warning/10 text-warning dark:bg-warning/20 dark:text-warning`}>
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
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
