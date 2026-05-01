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
  /** When true, render the value (no label) in the top-right of the
   *  mobile card next to the primary cell — used for status pills /
   *  badges that belong with the title block, not in a separate row. */
  mobileBadge?: boolean;
  /** When true, render the cell as the bottom action toolbar of the
   *  mobile card (full-width, flex-wrap, no label). Use for the
   *  "actions" column with its row of buttons. Replaces the old
   *  label/value row which crammed buttons into 50% of the card width. */
  mobileActions?: boolean;
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
 * phone instead of horizontally-scrolled mini-text or label/value rows
 * with 60% empty middle space.
 *
 * Mobile card layout:
 *   ┌──────────────────────────────────┐
 *   │ <primaryOnMobile>      <badge>   │  ← title + status pill
 *   │ ──────────────────────────────── │
 *   │ Header A   <cell>                │  ← label · value rows
 *   │ Header B   <cell>                │
 *   │ ──────────────────────────────── │
 *   │ <mobileActions cell, full-width> │  ← action toolbar
 *   └──────────────────────────────────┘
 *
 * Columns can opt into specific roles via `primaryOnMobile`,
 * `mobileBadge`, or `mobileActions`. Columns marked `hideOnMobile` are
 * dropped from the card entirely. Anything else becomes a label/value
 * row, but with `gap-3` natural flow rather than `justify-between` —
 * killed the empty-middle gap that made every list look like data fell
 * off the right side of the screen.
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
  const badgeColumns = mobileColumns.filter(c => c.mobileBadge);
  const actionsColumn = mobileColumns.find(c => c.mobileActions);
  const labelColumns = mobileColumns.filter(
    c => !c.primaryOnMobile && !c.mobileBadge && !c.mobileActions
  );

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
            {/* Title row: primary cell on the left, badges on the right.
                Wraps if the title is long so badges don't get pushed
                off-card. */}
            {(primaryColumn || badgeColumns.length > 0) && (
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 text-base font-semibold text-foreground">
                  {primaryColumn?.cell(row, i)}
                </div>
                {badgeColumns.length > 0 && (
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {badgeColumns.map((c, ci) => (
                      <div key={ci}>{c.cell(row, i)}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Label/value rows. `gap-3` natural flow (label hugs left,
                value hugs label) — no more `justify-between` blowing up
                short values to the right edge of the card. */}
            {labelColumns.length > 0 && (
              <dl
                className={`space-y-1 text-sm ${
                  primaryColumn || badgeColumns.length > 0 ? 'mt-3' : ''
                }`}
              >
                {labelColumns.map((c, ci) => (
                  <div key={ci} className="flex items-baseline gap-3">
                    <dt className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {c.header}
                    </dt>
                    <dd
                      className={`min-w-0 flex-1 text-foreground ${
                        c.alignEnd ? 'text-end' : 'text-start'
                      }`}
                    >
                      {c.cell(row, i)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {/* Actions toolbar — full-width strip at the bottom of the
                card, with overflow-x-auto so 4+ buttons can scroll
                horizontally rather than wrap. The wrapped child (a
                button/link) decides its own padding/sizing. */}
            {actionsColumn && (
              <div
                className="-mx-1 mt-3 flex items-center gap-2 overflow-x-auto px-1 pt-2 [&_*]:shrink-0 border-t border-border/40"
                onClick={e => e.stopPropagation()}
              >
                {actionsColumn.cell(row, i)}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
