'use client';

import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

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
        <span className="text-xs text-muted-foreground">
          {new Date(row.createdAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      className: 'w-20',
      cell: row => (
        <button
          type="button"
          onClick={() => onDelete(row.id)}
          disabled={deletingId === row.id}
          className="px-2 py-1 rounded border border-destructive/40 text-destructive text-xs hover:bg-destructive/10 disabled:opacity-50 max-sm:min-h-11 max-sm:px-4"
        >
          {deletingId === row.id ? '…' : t('redirectsDelete')}
        </button>
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
