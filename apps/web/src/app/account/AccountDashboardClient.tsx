'use client';

import { storeNumerals } from '@ebda/shared';
import { useState, useEffect } from 'react';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import Link from '../../components/StoreLink';
import { api, type Order } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useFeatures } from '../../contexts/FeatureContext';
import { useAuth } from '../../contexts/AuthContext';
import { formatDate as formatStoreDate } from '@/lib/format-date';

export default function AccountDashboardClient() {
  const storeUrl = useStoreUrl();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { store } = useStore();
  const { t, language } = useLanguage();
  const { isEnabled } = useFeatures();
  const formatPrice = useLocalePrice();
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [wishlistCount, setWishlistCount] = useState(0);
  const [addressCount, setAddressCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // STORE-QA-43: a guest is redirected to sign-in by the account layout; do not call the authed endpoints
    // first (two red 401s in the console). Wait for the session answer, then fetch only when signed in.
    if (authLoading || !isAuthenticated) return;
    fetchOrders();
    // Wishlist count — real data from the wishlist API (was hardcoded 0).
    api
      .get<{ items: unknown[] }>('/wishlist')
      .then(r => {
        if (r.success && Array.isArray(r.data?.items)) setWishlistCount(r.data.items.length);
      })
      .catch(() => undefined);
  }, [authLoading, isAuthenticated]);

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
        setError(result.error.message || t('Failed to load orders', 'فشل تحميل الطلبات'));
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
      setError(
        t(
          'Unable to load orders. Please check your connection.',
          'معرفناش نحمّل الطلبات. اتأكد من اتصالك بالإنترنت.'
        )
      );
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
      numerals: storeNumerals(store?.theme),
      style: 'long',
    });
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-warning/20 text-warning-ink',
    processing: 'bg-info/20 text-info-ink',
    shipped: 'bg-info/10 text-info-ink',
    delivered: 'bg-success/20 text-success-ink',
    cancelled: 'bg-destructive/20 text-destructive-ink',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {t('Account Dashboard', 'لوحة التحكم')}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t('Manage your account and view your orders', 'إدارة حسابك وعرض طلباتك')}
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 text-destructive-ink flex-shrink-0"
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
            <p className="text-destructive-ink flex-1">{error}</p>
            <button
              onClick={() => fetchOrders()}
              className="px-3 py-1 text-sm bg-destructive/20 text-destructive-ink rounded hover:bg-destructive/30 transition-colors"
            >
              {t('Retry', 'إعادة المحاولة')}
            </button>
          </div>
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-info/20">
              <svg
                className="h-6 w-6 text-info-ink"
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
              <p className="text-2xl font-bold text-foreground tabular-nums">
                {recentOrders.length}
              </p>
              <p className="text-sm text-muted-foreground">{t('Total Orders', 'إجمالي الطلبات')}</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-success/20">
              <svg
                className="h-6 w-6 text-success-ink"
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
                {t('Saved Addresses', 'العناوين المحفوظة')}
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
                {t('Wishlist Items', 'قائمة الأمنيات')}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Orders */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold text-foreground">{t('Recent Orders', 'الطلبات الأخيرة')}</h2>
          <Link href={storeUrl('/account/orders')} className="text-sm text-primary hover:underline">
            {t('View All', 'عرض الكل')}
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
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                      statusColors[order.status] || 'bg-muted text-foreground'
                    }`}
                  >
                    {order.status}
                  </span>
                  <p className="mt-1 font-medium text-foreground tabular-nums">
                    {formatPrice(order.total)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center">
            <svg
              className="mx-auto h-12 w-12 text-muted-foreground"
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
            <p className="mt-4 text-muted-foreground">{t('No orders yet', 'مفيش طلبات لسه')}</p>
            <Link
              href={storeUrl('/products')}
              className="mt-2 inline-block text-primary hover:underline"
            >
              {t('Start shopping', 'ابدأ التسوق')}
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
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/20">
            <svg
              className="h-5 w-5 text-success-ink"
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
            <p className="font-medium text-foreground">{t('Add Address', 'إضافة عنوان')}</p>
            <p className="text-sm text-muted-foreground">
              {t('Save a new delivery address', 'حفظ عنوان توصيل جديد')}
            </p>
          </div>
        </Link>

        <Link
          href={storeUrl('/account/settings')}
          className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-info/20">
            <svg
              className="h-5 w-5 text-info-ink"
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
            <p className="font-medium text-foreground">{t('Account Settings', 'إعدادات الحساب')}</p>
            <p className="text-sm text-muted-foreground">
              {t('Update your profile and password', 'تحديث ملفك الشخصي وكلمة المرور')}
            </p>
          </div>
        </Link>

        {/* Loyalty entry point — only shown when the store has loyalty enabled */}
        {isEnabled('loyalty') && (
          <Link
            href={storeUrl('/account/loyalty')}
            className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md sm:col-span-2"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <svg
                className="h-5 w-5 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                />
              </svg>
            </div>
            <div className="flex-1">
              <p className="font-medium text-foreground">{t('Loyalty Rewards', 'مكافآت الولاء')}</p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Earn points on every order and redeem for discounts',
                  'اكسب نقط على كل طلب واستبدلها بخصومات'
                )}
              </p>
            </div>
            <svg
              className="h-5 w-5 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        )}
      </div>
    </div>
  );
}
