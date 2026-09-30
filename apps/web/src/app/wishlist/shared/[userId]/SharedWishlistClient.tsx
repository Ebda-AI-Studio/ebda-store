'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { isOnSale } from '../../../../lib/product-pricing';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../../components';
import { useStore, useStoreUrl } from '../../../../contexts/StoreContext';
import { useLanguage } from '../../../../contexts/LanguageContext';

interface WishlistProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  status: string;
}

interface WishlistItem {
  id: string;
  product: WishlistProduct;
}

interface Props {
  userId: string;
}

export default function SharedWishlistClient({ userId }: Props) {
  const router = useRouter();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();

  const [items, setItems] = useState<WishlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasFetched = useRef(false);

  const loadSharedWishlist = useCallback(async () => {
    if (!store.id || store.id === 'demo') return;

    setError(null);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/public/${store.id}/wishlist/${userId}`,
        { credentials: 'include' }
      );
      const data = await response.json();

      if (data.success) {
        setItems(data.data.items || []);
      } else if (data.error?.code === 'PRIVATE_WISHLIST') {
        setIsPrivate(true);
      } else if (data.error?.code === 'NOT_FOUND') {
        setError(t('Wishlist not found', 'قائمة المفضلة غير موجودة'));
      } else {
        setError(data.error?.message || t('Failed to load wishlist', 'فشل تحميل قائمة المفضلة'));
      }
    } catch {
      setError(
        t(
          'Unable to load wishlist. Please check your connection.',
          'تعذر تحميل قائمة المفضلة. يرجى التحقق من اتصالك.'
        )
      );
    }
    setIsLoading(false);
  }, [store.id, userId, t]);

  useEffect(() => {
    if (hasFetched.current) return;
    if (!store.id || store.id === 'demo') return;
    hasFetched.current = true;
    loadSharedWishlist();
  }, [loadSharedWishlist, store.id]);

  async function addToCart(productId: string) {
    setActionError(null);
    try {
      const response = await api.addToCart(productId, 1);
      if (response.success) {
        router.push(storeUrl('/cart'));
      } else {
        setActionError(
          (response.error as { message?: string })?.message ||
            t('Failed to add to cart', 'فشل الإضافة إلى السلة')
        );
      }
    } catch {
      setActionError(
        t(
          'Failed to add to cart. Please try again.',
          'فشل الإضافة إلى السلة. يرجى المحاولة مرة أخرى.'
        )
      );
    }
  }

  if (isLoading) {
    return (
      <MinimalChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">
            {t('Shared Wishlist', 'قائمة المفضلة المشتركة')}
          </h1>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-muted animate-pulse h-24 rounded-lg" />
            ))}
          </div>
        </div>
      </MinimalChrome>
    );
  }

  if (isPrivate) {
    return (
      <MinimalChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <div className="text-center py-16 bg-muted rounded-xl">
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
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            <h2 className="text-xl font-semibold mb-2">
              {t('This wishlist is private', 'قائمة المفضلة هذه خاصة')}
            </h2>
            <p className="text-muted-foreground">
              {t(
                'The owner has not made this wishlist public.',
                'لم يجعل المالك قائمة المفضلة هذه عامة.'
              )}
            </p>
          </div>
        </div>
      </MinimalChrome>
    );
  }

  if (error) {
    return (
      <MinimalChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
            <p className="text-destructive-ink">{error}</p>
          </div>
        </div>
      </MinimalChrome>
    );
  }

  return (
    <MinimalChrome>
      <div className="container mx-auto px-4 py-8 flex-1">
        <h1 className="text-3xl font-bold mb-8">
          {t('Shared Wishlist', 'قائمة المفضلة المشتركة')}
        </h1>

        {/* Action Error */}
        {actionError && (
          <div
            role="alert"
            className="mb-6 p-4 bg-warning/10 border border-warning/30 rounded-lg flex items-center justify-between gap-3"
          >
            <p className="text-warning-ink">{actionError}</p>
            <button
              onClick={() => setActionError(null)}
              className="p-1 text-warning-ink hover:text-warning-ink"
              aria-label={t('Dismiss', 'إغلاق')}
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        )}

        {items.length === 0 ? (
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
              {t('This wishlist is empty', 'قائمة المفضلة فارغة')}
            </h2>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map(item => (
              <div
                key={item.id}
                className="bg-card rounded-2xl shadow-md p-4 flex items-center gap-4"
              >
                <Link href={storeUrl(`/products/${item.product.slug}`)} className="flex-shrink-0">
                  <div className="w-24 h-24 bg-muted rounded-lg overflow-hidden">
                    {item.product.images?.[0] ? (
                      <Image
                        src={item.product.images[0]}
                        alt={item.product.name}
                        width={96}
                        height={96}
                        className="w-full h-full object-cover"
                        sizes="96px"
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
                    {isOnSale(item.product) && (
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
                    <span className="text-destructive-ink text-sm">
                      {t('Currently unavailable', 'غير متوفر حالياً')}
                    </span>
                  )}
                </div>

                <div className="flex-shrink-0">
                  <button
                    onClick={() => addToCart(item.product.id)}
                    disabled={item.product.status !== 'active'}
                    className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('Add to Cart', 'أضف إلى السلة')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </MinimalChrome>
  );
}
