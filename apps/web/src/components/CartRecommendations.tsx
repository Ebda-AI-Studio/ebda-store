'use client';

import { useState, useEffect } from 'react';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { useTemplateComponents } from '../hooks/useTemplateComponents';
import { useToast } from '@force/ui';
import { API_URL } from '@/lib/api';
import type { TemplateProduct } from '../templates/types';

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

function toTpl(p: RecommendedProduct): TemplateProduct {
  return {
    id: p.id,
    name: p.name,
    nameAr: p.nameAr,
    slug: p.slug,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    images: p.images,
    inStock: true,
  };
}

export function CartRecommendations({ storeId, productIds }: CartRecommendationsProps) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { addItem, items: cartItems } = useCart();
  const { language, t } = useLanguage();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const { success: toastSuccess } = useToast();
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
        if (data.success && data.data?.products?.length) {
          setProducts(data.data.products.slice(0, 4));
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
    const displayName = language === 'ar' && p.nameAr ? p.nameAr : p.name;
    await addItem({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      price: p.price,
      slug: p.slug,
      image: p.images?.[0]?.url,
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
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        {t('Recommended based on your cart', 'موصى به بناءً على سلتك')}
      </p>
      <T.ProductGrid
        products={products.map(toTpl)}
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
