'use client';

import { cn } from '../../utils/cn';

// ==========================================
// Skeleton Loading Components
// ==========================================

interface SkeletonProps {
  className?: string;
}

// Base Skeleton — shimmer animation via inline keyframe style injection
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded bg-muted',
        'before:absolute before:inset-0 before:-translate-x-full',
        'before:animate-shimmer',
        'before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent',
        className
      )}
    />
  );
}

// Product Card Skeleton
export function SkeletonProductCard({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/50 bg-card overflow-hidden shadow-sm',
        className
      )}
    >
      <Skeleton className="h-48 w-full rounded-none" />
      <div className="p-4 space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex justify-between items-center pt-2">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

// Table Row Skeleton (internal helper for SkeletonTable)
function SkeletonTableRow({ columns = 4, className }: { columns?: number; className?: string }) {
  return (
    <tr className={cn('border-b', className)}>
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}

// Table Skeleton
export function SkeletonTable({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/50 bg-card overflow-hidden shadow-sm',
        className
      )}
    >
      <table className="w-full">
        <thead className="bg-muted/50 border-b">
          <tr>
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="px-4 py-3 text-left">
                <Skeleton className="h-4 w-20" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <SkeletonTableRow key={i} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Stats Card Skeleton (internal helper for SkeletonDashboardStats)
function SkeletonStats({ className }: SkeletonProps) {
  return (
    <div className={cn('rounded-xl border border-border/50 bg-card p-6 shadow-sm', className)}>
      <div className="flex justify-between items-start mb-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-8 rounded" />
      </div>
      <Skeleton className="h-8 w-32 mb-2" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

// Dashboard Stats Grid Skeleton
export function SkeletonDashboardStats({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStats key={i} />
      ))}
    </div>
  );
}
