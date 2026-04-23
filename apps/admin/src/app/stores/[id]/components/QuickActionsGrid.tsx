'use client';

import Link from 'next/link';

interface QuickActionsGridProps {
  storeId: string;
  storeStatus: string;
  productsCount: number;
  ordersCount: number;
  onStatusChange: (newStatus: string) => void;
}

export function QuickActionsGrid({
  storeId,
  storeStatus,
  productsCount,
  ordersCount,
  onStatusChange,
}: QuickActionsGridProps) {
  return (
    <div className="mt-8">
      <h2 className="mb-4 font-semibold text-foreground">Quick Actions</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {storeStatus === 'active' ? (
          <button
            onClick={() => onStatusChange('suspended')}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-destructive/40 hover:shadow-md text-left"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
              <svg
                className="h-5 w-5 text-destructive"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-foreground">Suspend Store</p>
              <p className="text-xs text-muted-foreground">Temporarily disable access</p>
            </div>
          </button>
        ) : (
          <button
            onClick={() => onStatusChange('active')}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-success/40 hover:shadow-md text-left"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
              <svg
                className="h-5 w-5 text-success"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-foreground">Activate Store</p>
              <p className="text-xs text-muted-foreground">Enable store access</p>
            </div>
          </button>
        )}

        <Link
          href={`/stores/${storeId}/products`}
          className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info/10">
            <svg
              className="h-5 w-5 text-info"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">View Products</p>
            <p className="text-xs text-muted-foreground">{productsCount} products</p>
          </div>
        </Link>

        <Link
          href={`/stores/${storeId}/orders`}
          className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info/10">
            <svg
              className="h-5 w-5 text-info"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">View Orders</p>
            <p className="text-xs text-muted-foreground">{ordersCount} orders</p>
          </div>
        </Link>

        <Link
          href={`/stores/${storeId}/analytics`}
          className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
            <svg
              className="h-5 w-5 text-success"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">Analytics</p>
            <p className="text-xs text-muted-foreground">View store metrics</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
