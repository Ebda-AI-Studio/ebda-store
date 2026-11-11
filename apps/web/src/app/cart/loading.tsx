import { Skeleton } from '@ebda/ui';
import { ShopChrome } from '../../components';

export default function CartLoading() {
  return (
    <ShopChrome>
      <div className="mx-auto min-h-[70svh] w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
        <div className="h-9 w-48 animate-pulse rounded bg-muted" />

        <div className="mt-8 lg:grid lg:grid-cols-12 lg:gap-8">
          {/* Cart Items Skeleton */}
          <div className="lg:col-span-8">
            <div className="space-y-4">
              {[1].map(i => (
                <div key={i} className="flex gap-4 rounded-xl border bg-card p-4 shadow-sm">
                  <Skeleton className="h-24 w-24 rounded-lg" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-4 w-24" />
                    <div className="mt-auto flex items-center justify-between">
                      <Skeleton className="h-8 w-28 rounded-lg" />
                      <Skeleton className="h-6 w-20" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Order Summary Skeleton */}
          <div className="mt-8 lg:col-span-4 lg:mt-0">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <Skeleton className="h-6 w-32" />
              <div className="mt-6 space-y-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="flex justify-between">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
                <div className="border-t pt-4">
                  <div className="flex justify-between">
                    <Skeleton className="h-6 w-16" />
                    <Skeleton className="h-6 w-24" />
                  </div>
                </div>
              </div>
              <Skeleton className="mt-6 h-12 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </ShopChrome>
  );
}
