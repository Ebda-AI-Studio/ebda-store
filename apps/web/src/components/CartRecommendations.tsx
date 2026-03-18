'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useToast } from '@force/ui';
import { formatPrice } from '@/lib/format';
import { API_URL } from '@/lib/api';

interface RecommendedProduct {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: Array<{ id: string; url: string; alt?: string }>;
}

interface CartRecommendationsProps {
  storeId: string;
  productIds: string[];
}

export function CartRecommendations({ storeId, productIds }: CartRecommendationsProps) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { addItem } = useCart();
  const { language, t } = useLanguage();
  const { success: toastSuccess } = useToast();

  useEffect(() => {
    if (!storeId || productIds.length === 0) {
      setIsLoading(false);
      return;
    }

    async function fetchRecommendations() {
      setIsLoading(true);
      try {
        const sessionId =
          typeof window !== 'undefined' ? localStorage.getItem('sessionId') || '' : '';
        const idsParam = productIds.join(',');
        const res = await fetch(
          `${API_URL}/public/${storeId}/cart/recommendations?products=${idsParam}`,
          {
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-Session-ID': sessionId,
              'X-Store-ID': storeId,
            },
          }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.success && data.data?.products?.length) {
          setProducts(data.data.products.slice(0, 4));
        }
      } catch {
        // Silently fail — recommendations are non-critical
      } finally {
        setIsLoading(false);
      }
    }

    fetchRecommendations();
  }, [storeId, productIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || products.length === 0) return null;

  const handleAdd = (product: RecommendedProduct) => {
    const displayName = language === 'ar' && product.nameAr ? product.nameAr : product.name;
    addItem({
      id: product.id,
      name: product.name,
      nameAr: product.nameAr,
      price: product.price,
      slug: product.slug,
      image: product.images?.[0]?.url,
    });
    toastSuccess(
      t('Added to cart!', 'أضيف إلى السلة!'),
      `${displayName} ${t('added to your cart', 'أضيف إلى سلتك')}`
    );
  };

  return (
    <div className="mb-8 rounded-2xl border border-border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-bold text-foreground">
        {t('You Might Also Need', 'قد تحتاج أيضاً')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('Recommended based on your cart', 'موصى به بناءً على سلتك')}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {products.map(product => {
          const displayName = language === 'ar' && product.nameAr ? product.nameAr : product.name;
          return (
            <div
              key={product.id}
              className="group flex flex-col rounded-xl border border-border bg-background p-3 transition hover:shadow-md"
            >
              {/* Image */}
              <div className="relative aspect-square overflow-hidden rounded-lg bg-gradient-to-br from-primary/5 to-primary/10">
                {product.images?.[0]?.url ? (
                  <Image
                    src={product.images[0].url}
                    alt={product.images[0].alt || displayName}
                    width={200}
                    height={200}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    sizes="(max-width: 640px) 50vw, 25vw"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20">
                      <svg
                        className="h-5 w-5 text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                        />
                      </svg>
                    </div>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="mt-2 flex flex-1 flex-col">
                <h3 className="line-clamp-2 text-xs font-semibold text-foreground transition-colors group-hover:text-primary">
                  {displayName}
                </h3>
                <span className="mt-1 text-sm font-bold text-primary">
                  {formatPrice(product.price)}
                </span>
              </div>

              {/* Quick Add */}
              <button
                onClick={() => handleAdd(product)}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary hover:text-white"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                {t('Add', 'أضف')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
