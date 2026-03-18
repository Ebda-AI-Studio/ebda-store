'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreUrl } from '../contexts/StoreContext';
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

interface YouMightAlsoLikeProps {
  storeId: string;
  productId: string;
}

export function YouMightAlsoLike({ storeId, productId }: YouMightAlsoLikeProps) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { addItem } = useCart();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const { success: toastSuccess } = useToast();

  useEffect(() => {
    if (!storeId || !productId) return;

    async function fetchRecommendations() {
      setIsLoading(true);
      try {
        const sessionId =
          typeof window !== 'undefined' ? localStorage.getItem('sessionId') || '' : '';
        const res = await fetch(
          `${API_URL}/public/${storeId}/products/${productId}/recommendations`,
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
        if (data.success && data.data) {
          const upsell: RecommendedProduct[] = data.data.upsell || [];
          const alsoLike: RecommendedProduct[] = data.data.alsoLike || [];
          // Merge upsell + alsoLike, deduplicate by id
          const seen = new Set<string>();
          const merged: RecommendedProduct[] = [];
          for (const p of [...upsell, ...alsoLike]) {
            if (!seen.has(p.id)) {
              seen.add(p.id);
              merged.push(p);
            }
          }
          setProducts(merged);
        }
      } catch {
        // Silently fail — recommendations are non-critical
      } finally {
        setIsLoading(false);
      }
    }

    fetchRecommendations();
  }, [storeId, productId]);

  if (isLoading || products.length === 0) return null;

  const handleAddToCart = (product: RecommendedProduct, e: React.MouseEvent) => {
    e.preventDefault();
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
    <div className="mt-16">
      <h2 className="text-2xl font-bold text-foreground">
        {t('You Might Also Like', 'قد يعجبك أيضاً')}
      </h2>

      {/* Horizontal scroll container */}
      <div className="mt-6 flex gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border">
        {products.map(product => {
          const displayName = language === 'ar' && product.nameAr ? product.nameAr : product.name;
          return (
            <Link
              key={product.id}
              href={storeUrl(`/products/${product.slug}`)}
              className="group flex w-48 flex-shrink-0 flex-col rounded-2xl border border-border bg-card p-3 shadow-sm transition hover:shadow-lg"
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
                    sizes="192px"
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
                {product.compareAtPrice && product.compareAtPrice > product.price && (
                  <span className="absolute left-2 top-2 rounded bg-red-500 px-1.5 py-0.5 text-xs font-medium text-white">
                    {t('Sale', 'تخفيض')}
                  </span>
                )}
              </div>

              {/* Info */}
              <div className="mt-2 flex flex-1 flex-col">
                <h3 className="line-clamp-2 text-xs font-semibold text-foreground transition-colors group-hover:text-primary">
                  {displayName}
                </h3>
                <div className="mt-1 flex items-center gap-1">
                  <span className="text-sm font-bold text-primary">
                    {formatPrice(product.price)}
                  </span>
                  {product.compareAtPrice && product.compareAtPrice > product.price && (
                    <span className="text-xs text-muted-foreground line-through">
                      {formatPrice(product.compareAtPrice)}
                    </span>
                  )}
                </div>
              </div>

              {/* Add to Cart */}
              <button
                onClick={e => handleAddToCart(product, e)}
                className="mt-2 w-full rounded-lg bg-primary px-2 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
              >
                {t('Add to Cart', 'أضف إلى السلة')}
              </button>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
