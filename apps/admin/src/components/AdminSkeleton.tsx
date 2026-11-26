/**
 * AdminSkeleton — shared route-loading skeleton primitives for the admin app.
 *
 * Each exported piece uses the project's `force-skeleton` utility class
 * (`animate-pulse rounded-lg bg-muted`) so colours come from design tokens,
 * not hardcoded values. `force-stat-card` mirrors the real stat card shell.
 *
 * Designed mobile-first (375px baseline) and RTL-safe (logical properties
 * `ps`/`pe`/`ms`/`me` where direction matters; no `left`/`right` offsets).
 *
 * Usage — each loading.tsx composes from these pieces:
 *
 *   variant="cards"  → AdminSkeletonCards
 *   variant="table"  → AdminSkeletonTable
 *   variant="chart"  → AdminSkeletonChart
 *   variant="detail" → AdminSkeletonDetail
 *
 * Convenience wrapper that composes all four per-page shapes:
 *   <AdminSkeletonPage variants={['cards', 'chart', 'table']} />
 */

// ─── Stat-card row ─────────────────────────────────────────────────────────

interface AdminSkeletonCardsProps {
  /** Number of stat cards to render. Defaults to 4. */
  count?: number;
  className?: string;
}

export function AdminSkeletonCards({ count = 4, className }: AdminSkeletonCardsProps) {
  return (
    <div
      className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 ${className ?? ''}`}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="force-stat-card">
          <div className="flex items-start justify-between">
            <div className="flex-1 space-y-3">
              {/* Label */}
              <div className="force-skeleton h-3 w-24" />
              {/* Value */}
              <div className="force-skeleton h-8 w-28" />
              {/* Sub-label */}
              <div className="force-skeleton h-3 w-16" />
            </div>
            {/* Icon placeholder */}
            <div className="force-skeleton h-12 w-12 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Table ────────────────────────────────────────────────────────────────────

interface AdminSkeletonTableProps {
  /** Visible rows to render. Defaults to 6. */
  rows?: number;
  /** Columns — on mobile ≤375px the table stacks to blocks. Defaults to 4. */
  columns?: number;
  /** Show a search/filter toolbar skeleton above the table. Defaults to true. */
  showToolbar?: boolean;
  className?: string;
}

export function AdminSkeletonTable({
  rows = 6,
  columns = 4,
  showToolbar = true,
  className,
}: AdminSkeletonTableProps) {
  return (
    <div className={`space-y-4 ${className ?? ''}`} aria-hidden="true">
      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Search input skeleton */}
          <div className="force-skeleton h-9 w-full sm:w-64" />
          {/* Action button skeleton */}
          <div className="force-skeleton h-9 w-28" />
        </div>
      )}

      {/* Desktop table — hidden below md (matches DataTable's md breakpoint,
          so the skeleton never shows the desktop shape on a viewport where
          the real, loaded table would already be cards). */}
      <div className="hidden md:block rounded-md border bg-card overflow-hidden shadow-sm">
        <table className="w-full" aria-hidden="true">
          <thead className="bg-muted/50 border-b">
            <tr>
              {Array.from({ length: columns }).map((_, i) => (
                <th key={i} className="px-4 py-3 text-start">
                  <div className="force-skeleton h-4 w-20" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {Array.from({ length: rows }).map((_, i) => (
              <tr key={i}>
                {Array.from({ length: columns }).map((_, j) => (
                  <td key={j} className="px-4 py-3">
                    <div
                      className="force-skeleton h-4"
                      style={{ width: j === 0 ? '60%' : j === columns - 1 ? '40%' : '80%' }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards — visible only below md */}
      <div className="space-y-3 md:hidden">
        {Array.from({ length: Math.min(rows, 4) }).map((_, i) => (
          <div key={i} className="rounded-md border bg-card p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <div className="force-skeleton h-4 w-2/5" />
              <div className="force-skeleton h-6 w-16 rounded-full" />
            </div>
            <div className="force-skeleton h-3 w-3/5" />
            <div className="force-skeleton h-3 w-2/5" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Chart ────────────────────────────────────────────────────────────────────

interface AdminSkeletonChartProps {
  /** Height of the chart area. Defaults to 'h-48'. */
  chartHeight?: string;
  /** Whether to render a legend row below the chart. Defaults to true. */
  showLegend?: boolean;
  className?: string;
}

export function AdminSkeletonChart({
  chartHeight = 'h-48',
  showLegend = true,
  className,
}: AdminSkeletonChartProps) {
  return (
    <div
      className={`rounded-md border bg-card p-4 sm:p-6 shadow-sm space-y-4 ${className ?? ''}`}
      aria-hidden="true"
    >
      {/* Chart title */}
      <div className="force-skeleton h-5 w-36" />
      {/* Chart area */}
      <div className={`force-skeleton w-full ${chartHeight}`} />
      {/* Legend */}
      {showLegend && (
        <div className="flex flex-wrap gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="force-skeleton h-3 w-3 rounded-full" />
              <div className="force-skeleton h-3 w-16" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Detail / form ────────────────────────────────────────────────────────────

interface AdminSkeletonDetailProps {
  /** Number of field rows to render. Defaults to 5. */
  fields?: number;
  /** Show a page-header skeleton (breadcrumb + action button). Defaults to true. */
  showHeader?: boolean;
  className?: string;
}

export function AdminSkeletonDetail({
  fields = 5,
  showHeader = true,
  className,
}: AdminSkeletonDetailProps) {
  return (
    <div className={`space-y-6 ${className ?? ''}`} aria-hidden="true">
      {showHeader && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Page title */}
          <div className="force-skeleton h-6 w-48" />
          {/* Action */}
          <div className="force-skeleton h-9 w-24" />
        </div>
      )}

      <div className="rounded-md border bg-card p-4 sm:p-6 shadow-sm space-y-5">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-2">
            {/* Field label */}
            <div className="force-skeleton h-3 w-24" />
            {/* Field input */}
            <div className="force-skeleton h-10 w-full" />
          </div>
        ))}
        {/* Submit area */}
        <div className="flex justify-end pt-2">
          <div className="force-skeleton h-9 w-24" />
        </div>
      </div>
    </div>
  );
}

// ─── Convenience compositor ───────────────────────────────────────────────────

type SkeletonVariant = 'cards' | 'table' | 'chart' | 'detail';

interface AdminSkeletonPageProps {
  /** Ordered list of skeleton sections to render top-to-bottom. */
  variants: SkeletonVariant[];
  /** Optional overrides forwarded to the cards section. */
  cardCount?: number;
  /** Optional overrides forwarded to the table section. */
  tableRows?: number;
  tableColumns?: number;
  className?: string;
}

/**
 * Renders the requested skeleton sections in order, separated by a consistent
 * vertical gap. Each loading.tsx uses this to describe its real page shape in
 * one short call, e.g.:
 *
 *   <AdminSkeletonPage variants={['cards', 'chart', 'table']} />
 */
export function AdminSkeletonPage({
  variants,
  cardCount,
  tableRows,
  tableColumns,
  className,
}: AdminSkeletonPageProps) {
  return (
    <div className={`space-y-6 ${className ?? ''}`}>
      {variants.map((v, i) => {
        switch (v) {
          case 'cards':
            return <AdminSkeletonCards key={i} count={cardCount} />;
          case 'chart':
            return <AdminSkeletonChart key={i} />;
          case 'table':
            return <AdminSkeletonTable key={i} rows={tableRows} columns={tableColumns} />;
          case 'detail':
            return <AdminSkeletonDetail key={i} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
