'use client';

interface StoresSkeletonProps {
  viewMode: 'grid' | 'table';
}

export function StoresSkeleton({ viewMode }: StoresSkeletonProps) {
  if (viewMode === 'grid') {
    return (
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="force-card animate-pulse">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-md bg-muted" />
                <div className="space-y-2">
                  <div className="h-4 w-24 rounded-md bg-muted" />
                  <div className="h-3 w-32 rounded-md bg-muted" />
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div className="h-3 w-full rounded-md bg-muted" />
              <div className="h-3 w-3/4 rounded-md bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="force-card p-0 overflow-hidden">
      <div className="space-y-4 p-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 animate-pulse">
            <div className="h-10 w-10 rounded-md bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 rounded-md bg-muted" />
              <div className="h-3 w-48 rounded-md bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
