import { SkeletonProductCard } from '@force/ui';
import { ShopChrome } from '../../components';

export default function ProductsLoading() {
  return (
    <ShopChrome>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header Skeleton */}
        <div className="mb-8">
          <div className="h-9 w-48 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-5 w-72 animate-pulse rounded bg-muted" />
        </div>

        {/* Filters Skeleton */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-10 w-24 animate-pulse rounded-full bg-muted" />
            ))}
          </div>
          <div className="h-10 w-full animate-pulse rounded-md bg-muted sm:w-64" />
        </div>

        {/* Products Grid Skeleton */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
            <SkeletonProductCard key={i} />
          ))}
        </div>
      </div>
    </ShopChrome>
  );
}
