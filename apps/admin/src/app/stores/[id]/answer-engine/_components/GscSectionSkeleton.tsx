'use client';

/** Loading placeholder for the GSC section — mirrors
 * `AnswerEngineSkeleton`'s force-skeleton pattern. */
export function GscSectionSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="force-stat-card">
            <div className="h-3 w-20 force-skeleton" />
            <div className="mt-2 h-8 w-24 force-skeleton" />
          </div>
        ))}
      </div>
      <div className="bg-card rounded-md border border-border p-6">
        <div className="h-32 force-skeleton" />
      </div>
    </div>
  );
}
