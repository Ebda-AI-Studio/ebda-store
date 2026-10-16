'use client';

import { useState, useEffect } from 'react';
import type { RecommendedProduct } from '../hooks/useProductRecommendations';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import { API_URL } from '@/lib/api';
import { recommendedToTemplateProduct } from '../templates/adapters';

interface CartRecommendationsProps {
  storeId: string;
  productIds: string[];
}

export function CartRecommendations({ storeId, productIds }: CartRecommendationsProps) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { addItem, items: cartItems } = useCart();
  const { language, t } = useLanguage();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const isRtl = language === 'ar';

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
        // The route answers `{ recommendations }` (recommendation.routes.ts);
        // this read `data.products`, which never existed, so the section had
        // never rendered on any store.
        const recs: RecommendedProduct[] | undefined = data.data?.recommendations;
        if (data.success && recs?.length) {
          setProducts(recs.slice(0, 4));
        }
      } catch {
        // Non-critical.
      } finally {
        setIsLoading(false);
      }
    }

    fetchRecommendations();
  }, [storeId, productIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || products.length === 0 || !T || templateLoading) return null;

  const cartQuantities: Record<string, number> = {};
  for (const item of cartItems) cartQuantities[item.productId] = item.quantity;

  const handleAdd = async (productId: string) => {
    const p = products.find(x => x.id === productId);
    if (!p) return;
    await addItem({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      price: p.price,
      slug: p.slug,
      image: p.images?.[0]?.url,
    });
    // Add-to-cart toast is centralized in CartContext.addItem
    // (Group E) — don't double-toast from per-component callers.
  };

  return (
    <div
      className="mb-8 rounded-2xl border border-border bg-card p-6 shadow-sm"
      data-zone="products"
    >
      <h2 className="text-lg font-bold text-foreground">
        {t('You Might Also Need', 'قد تحتاج أيضاً')}
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        {t('Recommended based on your cart', 'موصى به بناءً على سلتك')}
      </p>
      <T.ProductGrid
        products={products.map(recommendedToTemplateProduct)}
        isRtl={isRtl}
        currency={store.currency}
        columns={4}
        cartQuantities={cartQuantities}
        onAddToCart={handleAdd}
        urlPrefix={storeUrl('')}
      />
    </div>
  );
}
