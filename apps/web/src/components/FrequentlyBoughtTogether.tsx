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

interface FrequentlyBoughtTogetherProps {
  storeId: string;
  productId: string;
}

export function FrequentlyBoughtTogether({ storeId, productId }: FrequentlyBoughtTogetherProps) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { addItem } = useCart();
  const { language, t } = useLanguage();
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
        if (data.success && data.data?.crossSell?.length) {
          setProducts(data.data.crossSell);
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

  const handleAddToCart = (product: RecommendedProduct) => {
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

  const handleAddAllToCart = () => {
    products.forEach(product => {
      addItem({
        id: product.id,
        name: product.name,
        nameAr: product.nameAr,
        price: product.price,
        slug: product.slug,
        image: product.images?.[0]?.url,
      });
    });
    toastSuccess(
      t('Added all to cart!', 'أضيفت جميعها إلى السلة!'),
      `${products.length} ${t('items added to your cart', 'منتجات أضيفت إلى سلتك')}`
    );
  };

  return (
    <div className="mt-16">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-foreground">
          {t('Frequently Bought Together', 'يُشترى معاً في الغالب')}
        </h2>
        <button
          onClick={handleAddAllToCart}
          className="rounded-xl border border-primary px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-white"
        >
          {t('Add All to Cart', 'أضف الكل إلى السلة')}
        </button>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {products.map(product => {
          const displayName = language === 'ar' && product.nameAr ? product.nameAr : product.name;
          return (
            <div
              key={product.id}
              className="group rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:shadow-lg"
            >
              {/* Image */}
              <div className="relative aspect-square overflow-hidden rounded-lg bg-gradient-to-br from-primary/5 to-primary/10">
                {product.images?.[0]?.url ? (
                  <Image
                    src={product.images[0].url}
                    alt={product.images[0].alt || displayName}
                    width={300}
                    height={300}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20">
                      <svg
                        className="h-6 w-6 text-primary"
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
                  <span className="absolute left-2 top-2 rounded bg-destructive px-1.5 py-0.5 text-xs font-medium text-white">
                    {t('Sale', 'تخفيض')}
                  </span>
                )}
              </div>

              {/* Info */}
              <div className="mt-3">
                <h3 className="line-clamp-2 text-sm font-semibold text-foreground transition-colors group-hover:text-primary">
                  {displayName}
                </h3>
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-bold text-primary">{formatPrice(product.price)}</span>
                  {product.compareAtPrice && product.compareAtPrice > product.price && (
                    <span className="text-xs text-muted-foreground line-through">
                      {formatPrice(product.compareAtPrice)}
                    </span>
                  )}
                </div>
              </div>

              {/* Add to Cart */}
              <button
                onClick={() => handleAddToCart(product)}
                className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                {t('Add to Cart', 'أضف إلى السلة')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
