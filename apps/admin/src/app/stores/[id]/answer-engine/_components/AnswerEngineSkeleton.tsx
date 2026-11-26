'use client';

/** Loading placeholder — mirrors `analytics/_components/AnalyticsSkeleton.tsx`'s
 * force-skeleton pattern. */
export function AnswerEngineSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="force-stat-card">
            <div className="h-3 w-24 force-skeleton" />
            <div className="mt-2 h-8 w-32 force-skeleton" />
            <div className="mt-1 h-3 w-16 force-skeleton" />
          </div>
        ))}
      </div>
      <div className="bg-card rounded-md border border-border p-6">
        <div className="h-32 force-skeleton" />
      </div>
      <div className="bg-card rounded-md border border-border p-6">
        <div className="h-48 force-skeleton" />
      </div>
    </div>
  );
}
