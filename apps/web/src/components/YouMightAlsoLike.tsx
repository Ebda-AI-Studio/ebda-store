'use client';

import { useState, useEffect, useCallback } from 'react';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore, useStoreUrl, useStoreTemplate } from '../contexts/StoreContext';
import { API_URL } from '@/lib/api';
import { ProductCarousel } from '../templates/shared/ProductCarousel';
import { Skeleton } from '@force/ui';
import { SectionRetryNotice } from './SectionRetryNotice';

/** Loading placeholder sized to the eventual horizontal carousel strip
 *  (width baseline matches `ProductCarousel`'s xs card — see design.md
 *  "Carousel item (homepage strip)") — avoids the pop-in layout shift the
 *  previous `return null` caused while `isLoading` was true. */
function YouMightAlsoLikeSkeleton({ isRtl }: { isRtl: boolean }) {
  return (
    <div className="mt-16" aria-hidden="true">
      <Skeleton className="mb-4 h-6 w-48" />
      <div className={`flex gap-3 overflow-hidden sm:gap-4 ${isRtl ? 'flex-row-reverse' : ''}`}>
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="w-[44vw] flex-shrink-0 sm:w-[28vw] md:w-[22vw]">
            <Skeleton className="aspect-square w-full rounded-xl" />
            <Skeleton className="mt-2 h-4 w-3/4" />
            <Skeleton className="mt-1 h-4 w-1/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

interface RecommendedProduct {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | null;
  images: Array<{ id: string; url: string; alt?: string }>;
}

interface YouMightAlsoLikeProps {
  storeId: string;
  productId: string;
}

export function YouMightAlsoLike({ storeId, productId }: YouMightAlsoLikeProps) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  // Distinguishes a genuine fetch failure from "nothing to recommend" —
  // both used to collapse into the same `return null` (Lens M graceful
  // degradation).
  const [status, setStatus] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');
  const { addItem, items: cartItems } = useCart();
  const { language } = useLanguage();
  const { store, layout } = useStore();
  const storeUrl = useStoreUrl();
  const templateId = useStoreTemplate();
  const isRtl = language === 'ar';
  // Honour the same per-store productCardDefaults as the PLP and homepage
  // carousels so frame/size/shape settings apply on this surface too.
  // Eliminates the T.ProductGrid 4th render path: these cards now go through
  // PecannbeeProductCard (same path as PLP and catalog listings).
  const productCardDefaults = layout?.productCardDefaults;

  const fetchRecommendations = useCallback(async () => {
    if (!storeId || !productId) return;
    setStatus('loading');
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
      if (!res.ok) {
        setStatus('error');
        return;
      }
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
        setStatus(merged.length > 0 ? 'ok' : 'empty');
      } else {
        setProducts([]);
        setStatus('empty');
      }
    } catch {
      setStatus('error');
    }
  }, [storeId, productId]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  if (status === 'loading') return <YouMightAlsoLikeSkeleton isRtl={isRtl} />;
  if (status === 'error') {
    return (
      <div className="mt-16">
        <SectionRetryNotice
          onRetry={fetchRecommendations}
          message="Couldn't load You Might Also Like."
          messageAr="تعذّر تحميل قسم قد يعجبك أيضاً."
        />
      </div>
    );
  }
  if (status === 'empty' || products.length === 0) return null;

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
      {/* Compact horizontal carousel (was a 4-col grid of full-size cards).
          A "you might also like" strip sits BELOW the homepage section scale:
          heading capped at 20px, cards forced compact (xs). Reuses the canonical
          ProductCarousel so per-store frame/shape settings still apply. */}
      <ProductCarousel
        products={products.map(p => ({
          id: p.id,
          name: p.name,
          nameAr: p.nameAr,
          slug: p.slug,
          price: p.price,
          compareAtPrice: p.compareAtPrice,
          discountType: p.discountType ?? undefined,
          discountValue: p.discountValue ?? undefined,
          images: p.images,
          inStock: true,
        }))}
        title="You Might Also Like"
        titleAr="قد يعجبك أيضاً"
        headingZone={{ fontSize: '20px' }}
        isRtl={isRtl}
        currency={store.currency}
        pack={templateId}
        cardSize="xs"
        cardAspect={productCardDefaults?.cardAspect}
        cardShape={productCardDefaults?.cardShape}
        showCardFrame={productCardDefaults?.showCardFrame}
        cardFrameStyle={productCardDefaults?.cardFrameStyle}
        cardFrameWidth={productCardDefaults?.cardFrameWidth}
        cardFrameSize={productCardDefaults?.cardFrameSize}
        cardFrameColor={productCardDefaults?.cardFrameColor}
        showLabel={productCardDefaults?.showLabel}
        showHover={productCardDefaults?.showHover}
        cardImageAspect={productCardDefaults?.cardImageAspect}
        cardImageRadius={productCardDefaults?.cardImageRadius}
        showCardName={productCardDefaults?.showCardName}
        showCardPrice={
          store.theme?.showPriceOnCards === false ? false : productCardDefaults?.showCardPrice
        }
        urlPrefix={storeUrl('')}
        onAddToCart={handleAddToCart}
      />
    </div>
  );
}
