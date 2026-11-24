'use client';

import { formatDate } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { Button } from '@/components/ui/Button';

// Split out of page.tsx as a pure function of its props (#903) so it is
// testable without AdminLayout's context tree (auth/store/features/router) —
// the page itself owns fetching, the confirm dialog and AdminLayout, none of
// which this component touches.

export interface SlugRedirectRow {
  id: string;
  entityType: 'PRODUCT' | 'CATEGORY' | 'PAGE' | 'BLOG';
  fromSlug: string;
  toSlug: string;
  createdAt: string;
}

export interface RedirectsTableProps {
  rows: SlugRedirectRow[];
  deletingId: string | null;
  onDelete: (id: string) => void;
  t: (key: string) => string;
  ariaLabel: string;
}

export function RedirectsTable({ rows, deletingId, onDelete, t, ariaLabel }: RedirectsTableProps) {
  const columns: DataTableColumn<SlugRedirectRow>[] = [
    {
      header: t('redirectsFromSlug'),
      primaryOnMobile: true,
      cell: row => <span className="font-mono text-xs">{row.fromSlug}</span>,
    },
    {
      header: t('redirectsToSlug'),
      cell: row => <span className="font-mono text-xs text-muted-foreground">{row.toSlug}</span>,
    },
    {
      header: t('redirectsEntityType'),
      className: 'w-28',
      cell: row => <span className="text-xs text-muted-foreground">{row.entityType}</span>,
    },
    {
      header: t('redirectsCreatedAt'),
      className: 'w-32',
      cell: row => (
        <span className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</span>
      ),
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      className: 'w-20',
      cell: row => (
        <Button
          variant="outline"
          size="sm"
          className="border-destructive/40 text-destructive-ink"
          type="button"
          onClick={() => onDelete(row.id)}
          disabled={deletingId === row.id}
        >
          {deletingId === row.id ? '…' : t('redirectsDelete')}
        </Button>
      ),
    },
  ];

  return (
    <DataTable<SlugRedirectRow>
      ariaLabel={ariaLabel}
      columns={columns}
      rows={rows}
      rowKey={row => row.id}
      emptyState={<p className="text-muted-foreground text-sm">{t('redirectsEmpty')}</p>}
    />
  );
}
