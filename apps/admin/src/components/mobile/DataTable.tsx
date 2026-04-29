'use client';

import type { ReactNode } from 'react';

export interface DataTableColumn<T> {
  /** Column header. Doubles as the per-row label on the mobile card
   *  layout — keep it short and merchant-readable. */
  header: string;
  /** Renderer for the cell. Receives the row and its index so handlers
   *  can map back to the source array. */
  cell: (row: T, index: number) => ReactNode;
  /** Hide this column at narrow widths (mobile cards). Useful for long
   *  internal IDs, debug fields, or rarely-needed columns that would
   *  otherwise crowd the card. */
  hideOnMobile?: boolean;
  /** When true, the column is displayed as a single full-width row at
   *  the top of the mobile card (no label). Use for the row's primary
   *  identity — product name, order number, customer name. */
  primaryOnMobile?: boolean;
  /** Right-align this column (numbers, currency, status). */
  alignEnd?: boolean;
  /** Optional CSS for the desktop `<th>` / `<td>` (e.g. width, padding). */
  className?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** What to render when `rows` is empty. */
  emptyState?: ReactNode;
  /** Optional row click handler — applies on both layouts. */
  onRowClick?: (row: T, index: number) => void;
  /** When true, suppress the desktop `<table>` entirely and ALWAYS use
   *  the mobile card layout (handy for inherently card-like data like
   *  store cards). */
  alwaysCards?: boolean;
}

/**
 * Responsive table that renders a real `<table>` at `md+` and a stack
 * of cards on phones. Every dense list in the admin (orders, products,
 * customers, coupons, shipping zones, tax rates, loyalty members,
 * stores) is the same shape — one wrapper makes them all readable on a
 * phone instead of horizontally-scrolled mini-text.
 *
 * Mobile card layout:
 *   ┌──────────────────────────────────┐
 *   │ <primaryOnMobile cell>           │  ← bold, full-width
 *   │ Header A: <cell>                 │
 *   │ Header B: <cell>                 │
 *   │ ...                              │
 *   └──────────────────────────────────┘
 *
 * Columns marked `hideOnMobile` are dropped from the card; the rest
 * render as labelled rows. The author still gets full control because
 * `cell()` returns any ReactNode — chips, action menus, links, etc.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyState,
  onRowClick,
  alwaysCards = false,
}: DataTableProps<T>) {
  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const mobileColumns = columns.filter(c => !c.hideOnMobile);
  const primaryColumn = mobileColumns.find(c => c.primaryOnMobile);
  const labelColumns = mobileColumns.filter(c => !c.primaryOnMobile);

  return (
    <>
      {/* Desktop table */}
      {!alwaysCards && (
        <div className="hidden md:block overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {columns.map((c, i) => (
                  <th
                    key={i}
                    className={`px-4 py-3 font-medium ${
                      c.alignEnd ? 'text-end' : 'text-start'
                    } ${c.className ?? ''}`}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                  className={onRowClick ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}
                >
                  {columns.map((c, ci) => (
                    <td
                      key={ci}
                      className={`px-4 py-3 ${
                        c.alignEnd ? 'text-end' : 'text-start'
                      } ${c.className ?? ''}`}
                    >
                      {c.cell(row, i)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile cards */}
      <div className={alwaysCards ? 'space-y-3' : 'space-y-3 md:hidden'}>
        {rows.map((row, i) => (
          <div
            key={rowKey(row, i)}
            onClick={onRowClick ? () => onRowClick(row, i) : undefined}
            className={`rounded-xl border border-border bg-card p-4 shadow-sm ${
              onRowClick ? 'cursor-pointer active:bg-muted/50 transition-colors' : ''
            }`}
          >
            {primaryColumn && (
              <div className="mb-2 text-base font-semibold text-foreground">
                {primaryColumn.cell(row, i)}
              </div>
            )}
            <dl className="space-y-1.5 text-sm">
              {labelColumns.map((c, ci) => (
                <div key={ci} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {c.header}
                  </dt>
                  <dd className={`text-foreground ${c.alignEnd ? 'text-end' : 'text-start'}`}>
                    {c.cell(row, i)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}
