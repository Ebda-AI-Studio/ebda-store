'use client';

function StatCardSkeleton() {
  return (
    <div className="force-stat-card">
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <div className="h-3 w-24 force-skeleton" />
          <div className="h-8 w-32 force-skeleton" />
          <div className="h-3 w-16 force-skeleton" />
        </div>
        <div className="h-12 w-12 rounded-lg force-skeleton" />
      </div>
    </div>
  );
}

/**
 * Full-page placeholder shown while analytics data is loading.
 * Mirrors the real layout (4 stat cards + chart + 3-column grid) so the
 * content shift on load is minimal.
 */
export function AnalyticsSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <div className="bg-card rounded-md border p-6 shadow-sm mb-8">
        <div className="h-6 w-40 force-skeleton mb-6" />
        <div className="h-40 force-skeleton rounded-lg" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card rounded-md border p-6 shadow-sm space-y-4">
            <div className="h-5 w-32 force-skeleton" />
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg force-skeleton" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-28 force-skeleton" />
                  <div className="h-3 w-20 force-skeleton" />
                </div>
                <div className="h-5 w-16 force-skeleton" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
