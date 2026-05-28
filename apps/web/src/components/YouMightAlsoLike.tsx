'use client';

import { useState, useEffect } from 'react';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore, useStoreUrl, useStoreTemplate } from '../contexts/StoreContext';
import { API_URL } from '@/lib/api';
import { PecannbeeProductCard } from '../templates/shared/PecannbeeProductCard';
import { gridGapClass } from '../templates/shared/card-size';

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
  const { addItem, items: cartItems } = useCart();
  const { language, t } = useLanguage();
  const { store, layout } = useStore();
  const storeUrl = useStoreUrl();
  const templateId = useStoreTemplate();
  const isRtl = language === 'ar';
  // Honour the same per-store productCardDefaults as the PLP and homepage
  // carousels so frame/size/shape settings apply on this surface too.
  // Eliminates the T.ProductGrid 4th render path: these cards now go through
  // PecannbeeProductCard (same path as PLP and catalog listings).
  const productCardDefaults = layout?.productCardDefaults;

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
          // AI recommendations come back in crossSell slot when no manual
          // cross-sell relations exist (recommendation.service.ts: manual > AI > FBT).
          const crossSell: RecommendedProduct[] = data.data.crossSell || [];
          // Merge in priority order and dedupe.
          const seen = new Set<string>();
          const merged: RecommendedProduct[] = [];
          for (const p of [...upsell, ...crossSell, ...alsoLike]) {
            if (!seen.has(p.id)) {
              seen.add(p.id);
              merged.push(p);
            }
          }
          setProducts(merged);
        }
      } catch {
        // Non-critical.
      } finally {
        setIsLoading(false);
      }
    }

    fetchRecommendations();
  }, [storeId, productId]);

  if (isLoading || products.length === 0) return null;

  const cartQuantities: Record<string, number> = {};
  for (const item of cartItems) cartQuantities[item.productId] = item.quantity;

  const handleAddToCart = async (pid: string) => {
    const p = products.find(x => x.id === pid);
    if (!p) return;
    await addItem({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      price: p.price,
      slug: p.slug,
      image: p.images?.[0]?.url,
    });
    // Add-to-cart toast is centralized in CartContext.addItem (Group E).
  };

  return (
    <div className="mt-16">
      <h2 className="text-2xl font-bold text-foreground mb-6">
        {t('You Might Also Like', 'قد يعجبك أيضاً')}
      </h2>
      {/* Issue 2 fix (2026-05-28): PecannbeeProductCard honours per-store
          productCardDefaults (frame, size, shape) the same as PLP/carousels.
          Eliminates the T.ProductGrid 4th render path on the PDP. */}
      <div
        className={`grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 ${
          productCardDefaults?.cardGap
            ? gridGapClass(productCardDefaults.cardGap)
            : 'gap-3 sm:gap-4'
        }`}
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        {products.map(p => (
          <PecannbeeProductCard
            key={p.id}
            product={{
              id: p.id,
              name: p.name,
              nameAr: p.nameAr,
              slug: p.slug,
              price: p.price,
              compareAtPrice: p.compareAtPrice,
              images: p.images,
              inStock: true,
            }}
            isRtl={isRtl}
            currency={store.currency}
            pack={templateId}
            cardSize={productCardDefaults?.cardSize ?? 'md'}
            cardAspect={productCardDefaults?.cardAspect}
            cardShape={productCardDefaults?.cardShape}
            showCardFrame={productCardDefaults?.showCardFrame}
            cardFrameStyle={productCardDefaults?.cardFrameStyle}
            cardFrameWidth={productCardDefaults?.cardFrameWidth}
            cardFrameSize={productCardDefaults?.cardFrameSize}
            cardFrameColor={productCardDefaults?.cardFrameColor}
            showLabel={productCardDefaults?.showLabel}
            showHover={productCardDefaults?.showHover}
            urlPrefix={storeUrl('')}
            onAddToCart={handleAddToCart}
          />
        ))}
      </div>
    </div>
  );
}
