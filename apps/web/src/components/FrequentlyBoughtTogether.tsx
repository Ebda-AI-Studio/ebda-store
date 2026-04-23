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

interface FrequentlyBoughtTogetherProps {
  storeId: string;
  productId: string;
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

export function FrequentlyBoughtTogether({ storeId, productId }: FrequentlyBoughtTogetherProps) {
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
        // Non-critical.
      } finally {
        setIsLoading(false);
      }
    }

    fetchRecommendations();
  }, [storeId, productId]);

  if (isLoading || products.length === 0 || !T || templateLoading) return null;

  const cartQuantities: Record<string, number> = {};
  for (const item of cartItems) cartQuantities[item.productId] = item.quantity;

  const handleAddToCart = async (pid: string) => {
    const p = products.find(x => x.id === pid);
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

  const handleAddAllToCart = async () => {
    await Promise.all(
      products.map(p =>
        addItem({
          id: p.id,
          name: p.name,
          nameAr: p.nameAr,
          price: p.price,
          slug: p.slug,
          image: p.images?.[0]?.url,
        })
      )
    );
    toastSuccess(
      t('Added all to cart!', 'أضيفت جميعها إلى السلة!'),
      `${products.length} ${t('items added to your cart', 'منتجات أضيفت إلى سلتك')}`
    );
  };

  return (
    <div className="mt-16">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-bold text-foreground">
          {t('Frequently Bought Together', 'يُشترى معاً في الغالب')}
        </h2>
        <button
          onClick={handleAddAllToCart}
          className="rounded-xl border border-primary px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
        >
          {t('Add All to Cart', 'أضف الكل إلى السلة')}
        </button>
      </div>
      <T.ProductGrid
        products={products.map(toTpl)}
        isRtl={isRtl}
        currency={store.currency}
        columns={4}
        cartQuantities={cartQuantities}
        onAddToCart={handleAddToCart}
        urlPrefix={storeUrl('')}
      />
    </div>
  );
}
