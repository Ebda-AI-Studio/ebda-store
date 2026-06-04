'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api, type Order } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { formatPrice } from '@/lib/format';
import { formatDate as formatStoreDate } from '@/lib/format-date';

export default function AccountDashboardClient() {
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { t, language } = useLanguage();
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [wishlistCount, setWishlistCount] = useState(0);
  const [addressCount, setAddressCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
    // Wishlist count — real data from the wishlist API (was hardcoded 0).
    api
      .get<{ items: unknown[] }>('/wishlist')
      .then(r => {
        if (r.success && Array.isArray(r.data?.items)) setWishlistCount(r.data.items.length);
      })
      .catch(() => undefined);
  }, []);

  async function fetchOrders() {
    setError(null);
    try {
      const result = await api.getOrders();
      if (result.success && result.data) {
        setRecentOrders(result.data.orders.slice(0, 3));
        // "Saved Addresses" has no dedicated store yet — derive a real count
        // from the distinct shipping addresses the customer has actually used
        // (was hardcoded 0).
        const seen = new Set(
          result.data.orders
            .map(o => o.shippingAddress)
            .filter(Boolean)
            .map(a => JSON.stringify(a))
        );
        setAddressCount(seen.size);
      } else if (result.error) {
        setError(result.error.message || 'Failed to load orders');
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
      setError('Unable to load orders. Please check your connection.');
    } finally {
      setIsLoading(false);
    }
  }

  // Wrap the shared per-tenant formatter so the rest of the file can keep
  // calling `formatDate(order.createdAt)` without threading store/language
  // into every JSX site. Uses the long preset (Mon-day-year) to match the
  // dashboard's existing visual.
  function formatDate(date: string) {
    return formatStoreDate(date, {
      timezone: store.timezone,
      language,
      style: 'long',
    });
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-[hsl(var(--warning))]/20 text-[hsl(var(--warning))]',
    processing: 'bg-[hsl(var(--info))]/20 text-[hsl(var(--info))]',
    shipped: 'bg-info/10 text-info',
    delivered: 'bg-[hsl(var(--success))]/20 text-[hsl(var(--success))]',
    cancelled: 'bg-destructive/20 text-destructive',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {t('Account Dashboard', '\u0644\u0648\u062d\u0629 \u0627\u0644\u062a\u062d\u0643\u0645')}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t(
            'Manage your account and view your orders',
            '\u0625\u062f\u0627\u0631\u0629 \u062d\u0633\u0627\u0628\u0643 \u0648\u0639\u0631\u0636 \u0637\u0644\u0628\u0627\u062a\u0643'
          )}
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 text-destructive flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-destructive flex-1">{error}</p>
            <button
              onClick={() => fetchOrders()}
              className="px-3 py-1 text-sm bg-destructive/20 text-destructive rounded hover:bg-destructive/30 transition-colors"
            >
              {t(
                'Retry',
                '\u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[hsl(var(--info))]/20">
              <svg
                className="h-6 w-6 text-[hsl(var(--info))]"
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
              <p className="text-2xl font-bold text-foreground">{recentOrders.length}</p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Total Orders',
                  '\u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0637\u0644\u0628\u0627\u062a'
                )}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[hsl(var(--success))]/20">
              <svg
                className="h-6 w-6 text-[hsl(var(--success))]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground tabular-nums">{addressCount}</p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Saved Addresses',
                  '\u0627\u0644\u0639\u0646\u0627\u0648\u064a\u0646 \u0627\u0644\u0645\u062d\u0641\u0648\u0638\u0629'
                )}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
              <svg
                className="h-6 w-6 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                />
              </svg>
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground tabular-nums">{wishlistCount}</p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Wishlist Items',
                  '\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0623\u0645\u0646\u064a\u0627\u062a'
                )}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Orders */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold text-foreground">
            {t(
              'Recent Orders',
              '\u0627\u0644\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u0623\u062e\u064a\u0631\u0629'
            )}
          </h2>
          <Link href={storeUrl('/account/orders')} className="text-sm text-primary hover:underline">
            {t('View All', '\u0639\u0631\u0636 \u0627\u0644\u0643\u0644')}
          </Link>
        </div>

        {isLoading ? (
          <div className="p-8 text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : recentOrders.length > 0 ? (
          <div className="divide-y">
            {recentOrders.map(order => (
              <div key={order.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium text-foreground">#{order.orderNumber}</p>
                  <p className="text-sm text-muted-foreground">{formatDate(order.createdAt)}</p>
                </div>
                <div className="text-right">
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusColors[order.status] || 'bg-muted text-foreground'}`}
                  >
                    {order.status}
                  </span>
                  <p className="mt-1 font-medium text-foreground">{formatPrice(order.total)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center">
            <svg
              className="mx-auto h-12 w-12 text-muted-foreground/70"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p className="mt-4 text-muted-foreground">
              {t(
                'No orders yet',
                '\u0644\u0627 \u062a\u0648\u062c\u062f \u0637\u0644\u0628\u0627\u062a \u0628\u0639\u062f'
              )}
            </p>
            <Link
              href={storeUrl('/products')}
              className="mt-2 inline-block text-primary hover:underline"
            >
              {t('Start shopping', '\u0627\u0628\u062f\u0623 \u0627\u0644\u062a\u0633\u0648\u0642')}
            </Link>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href={storeUrl('/account/addresses')}
          className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--success))]/20">
            <svg
              className="h-5 w-5 text-[hsl(var(--success))]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">
              {t('Add Address', '\u0625\u0636\u0627\u0641\u0629 \u0639\u0646\u0648\u0627\u0646')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t(
                'Save a new delivery address',
                '\u062d\u0641\u0638 \u0639\u0646\u0648\u0627\u0646 \u062a\u0648\u0635\u064a\u0644 \u062c\u062f\u064a\u062f'
              )}
            </p>
          </div>
        </Link>

        <Link
          href={storeUrl('/account/settings')}
          className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--info))]/20">
            <svg
              className="h-5 w-5 text-[hsl(var(--info))]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">
              {t(
                'Account Settings',
                '\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062d\u0633\u0627\u0628'
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              {t(
                'Update your profile and password',
                '\u062a\u062d\u062f\u064a\u062b \u0645\u0644\u0641\u0643 \u0627\u0644\u0634\u062e\u0635\u064a \u0648\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
              )}
            </p>
          </div>
        </Link>
      </div>
    </div>
  );
}
