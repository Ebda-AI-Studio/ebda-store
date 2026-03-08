'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Header, Footer } from '../../components';
import { useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';

interface WishlistItem {
  id: string;
  product: {
    id: string;
    name: string;
    slug: string;
    price: number;
    compareAtPrice?: number;
    images: string[];
    status: string;
  };
}

export default function WishlistPage() {
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasFetched = useRef(false);

  const loadWishlist = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get<{ items: WishlistItem[] }>('/wishlist');
      if (response.success && response.data) {
        setItems(response.data.items || []);
      } else if (response.error?.code === 'UNAUTHORIZED') {
        localStorage.removeItem('accessToken');
        setIsLoggedIn(false);
      } else {
        setError(response.error?.message || 'Failed to load wishlist');
      }
    } catch (err) {
      console.error('Failed to load wishlist:', err);
      setError('Unable to load wishlist. Please check your connection.');
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    const checkAuthAndLoad = async () => {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        setIsLoggedIn(false);
        setIsLoading(false);
        return;
      }

      setIsLoggedIn(true);
      await loadWishlist();
    };

    checkAuthAndLoad();
  }, [loadWishlist]);

  async function removeFromWishlist(itemId: string) {
    setActionError(null);
    try {
      const response = await api.delete(`/wishlist/${itemId}`);
      if (response.success) {
        setItems(items.filter(item => item.id !== itemId));
      } else {
        setActionError('Failed to remove item from wishlist');
      }
    } catch (err) {
      console.error('Failed to remove item:', err);
      setActionError('Failed to remove item. Please try again.');
    }
  }

  async function addToCart(productId: string) {
    setActionError(null);
    try {
      const response = await api.post('/cart/items', { productId, quantity: 1 });
      if (response.success) {
        router.push(storeUrl('/cart'));
      } else {
        setActionError(response.error?.message || 'Failed to add to cart');
      }
    } catch (err) {
      console.error('Failed to add to cart:', err);
      setActionError('Failed to add to cart. Please try again.');
    }
  }

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">{t('My Wishlist', 'قائمة المفضلة')}</h1>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-muted animate-pulse h-24 rounded-lg"></div>
            ))}
          </div>
        </div>
        <Footer />
      </main>
    );
  }

  if (!isLoggedIn) {
    return (
      <main className="flex min-h-screen flex-col bg-background">
        <Header />
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">{t('My Wishlist', 'قائمة المفضلة')}</h1>
          <div className="text-center py-12 bg-muted rounded-xl">
            <svg
              className="w-16 h-16 text-muted-foreground mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
            <h2 className="text-xl font-semibold mb-2">
              {t('Sign in to view your wishlist', 'سجل دخولك لعرض قائمة المفضلة')}
            </h2>
            <p className="text-muted-foreground mb-4">
              {t('Save your favorite items for later', 'احفظ منتجاتك المفضلة لوقت لاحق')}
            </p>
            <Link
              href={storeUrl('/auth/login?redirect=/wishlist')}
              className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90"
            >
              {t('Sign In', translations['Sign In'])}
            </Link>
          </div>
        </div>
        <Footer />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 flex-1">
        <h1 className="text-3xl font-bold mb-8">{t('My Wishlist', 'قائمة المفضلة')}</h1>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5 text-red-500 flex-shrink-0"
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
              <p className="text-red-700 flex-1">{error}</p>
              <button
                onClick={() => loadWishlist()}
                className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Action Error Toast */}
        {actionError && (
          <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5 text-yellow-500 flex-shrink-0"
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
              <p className="text-yellow-700 flex-1">{actionError}</p>
              <button
                onClick={() => setActionError(null)}
                className="p-1 text-yellow-500 hover:text-yellow-700"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        )}

        {!error && items.length === 0 ? (
          <div className="text-center py-12 bg-background rounded-lg">
            <svg
              className="w-16 h-16 text-muted-foreground/70 mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
            <h2 className="text-xl font-semibold mb-2">
              {t('Your wishlist is empty', 'قائمة المفضلة فارغة')}
            </h2>
            <p className="text-muted-foreground mb-4">
              {t('Start adding products you love!', 'ابدأ بإضافة المنتجات التي تحبها!')}
            </p>
            <Link
              href={storeUrl('/products')}
              className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90"
            >
              {t('Browse Products', 'تصفح المنتجات')}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map(item => (
              <div
                key={item.id}
                className="bg-card rounded-lg shadow-md p-4 flex items-center gap-4"
              >
                <Link href={storeUrl(`/products/${item.product.slug}`)} className="flex-shrink-0">
                  <div className="w-24 h-24 bg-muted rounded-lg overflow-hidden">
                    {item.product.images?.[0] ? (
                      <img
                        src={item.product.images[0]}
                        alt={item.product.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground/70">
                        <svg
                          className="w-8 h-8"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </div>
                    )}
                  </div>
                </Link>

                <div className="flex-1 min-w-0">
                  <Link href={storeUrl(`/products/${item.product.slug}`)}>
                    <h3 className="font-semibold text-foreground hover:text-primary truncate">
                      {item.product.name}
                    </h3>
                  </Link>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="font-bold">
                      {new Intl.NumberFormat('en-KW', {
                        style: 'currency',
                        currency: 'KWD',
                        minimumFractionDigits: 3,
                      }).format(item.product.price / 1000)}
                    </span>
                    {item.product.compareAtPrice &&
                      item.product.compareAtPrice > item.product.price && (
                        <span className="text-muted-foreground/70 line-through text-sm">
                          {new Intl.NumberFormat('en-KW', {
                            style: 'currency',
                            currency: 'KWD',
                            minimumFractionDigits: 3,
                          }).format(item.product.compareAtPrice / 1000)}
                        </span>
                      )}
                  </div>
                  {item.product.status !== 'active' && (
                    <span className="text-red-500 text-sm">
                      {t('Currently unavailable', 'غير متوفر حالياً')}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => addToCart(item.product.id)}
                    disabled={item.product.status !== 'active'}
                    className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('Add to Cart', translations['Add to Cart'])}
                  </button>
                  <button
                    onClick={() => removeFromWishlist(item.id)}
                    className="p-2 text-muted-foreground/70 hover:text-red-500"
                    title={t('Remove from wishlist', 'إزالة من المفضلة')}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Footer />
    </main>
  );
}
