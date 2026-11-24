'use client';

export function FeedsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="bg-card rounded-lg border border-border p-5 space-y-3">
            <div className="h-4 w-40 force-skeleton" />
            <div className="h-3 w-56 force-skeleton" />
            <div className="h-9 w-full force-skeleton" />
            <div className="h-9 w-full force-skeleton" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="force-stat-card">
            <div className="h-3 w-24 force-skeleton" />
            <div className="mt-2 h-8 w-16 force-skeleton" />
          </div>
        ))}
      </div>
      <div className="bg-card rounded-lg border border-border p-6">
        <div className="h-40 force-skeleton" />
      </div>
    </div>
  );
}
