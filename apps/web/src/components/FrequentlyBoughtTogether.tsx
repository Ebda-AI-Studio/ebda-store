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
  /** Variants of this product (added 2026-05-16 to gate Add-all-to-cart
   *  for variant-parent products — those need the customer to pick a
   *  size/colour/etc. before adding, so the storefront can't add them
   *  silently from a recommendation card). Empty / missing = simple SKU. */
  variants?: Array<{ id: string; price: number }>;
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
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const isRtl = language === 'ar';

  // Variant-parent products can't be added to cart silently from a
  // recommendation card — the customer has to open the product detail
  // page and pick a size/colour/SKU first. Helper here so single-add and
  // add-all share the same detection logic.
  const hasVariants = (p: RecommendedProduct): boolean =>
    Array.isArray(p.variants) && p.variants.length > 0;

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
    // Variant-parent: redirect to PDP instead of trying to add. The card
    // can't know which variant the customer wants — surface the message,
    // open the product so they can pick.
    if (hasVariants(p)) {
      toastInfo(
        t('Choose a variant first', 'اختر نوع المنتج أولاً'),
        t(
          `"${p.name}" has options — open the product to pick one.`,
          `"${p.nameAr ?? p.name}" يحتوي على خيارات — افتح المنتج لاختيار النوع.`
        )
      );
      window.location.href = storeUrl(`/products/${p.slug}`);
      return;
    }
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

  const handleAddAllToCart = async () => {
    // Partition: variant-parent products can't be added blind (need
    // a SKU pick). Add the simple ones, then tell the merchant about
    // the ones that need a variant pick so they're not silently lost.
    const simple = products.filter(p => !hasVariants(p));
    const needVariant = products.filter(p => hasVariants(p));

    // Serialize the addItem calls instead of firing them in parallel.
    // The previous Promise.all racing the calls meant the cart-context
    // POSTs hit the API with stale local state — the second add saw
    // the cart pre-first-add, so the API ended up with only one of
    // the items merged in. Sequential awaits guarantee each addItem
    // sees the post-previous-add cart state.
    for (const p of simple) {
      await addItem({
        id: p.id,
        name: p.name,
        nameAr: p.nameAr,
        price: p.price,
        slug: p.slug,
        image: p.images?.[0]?.url,
      });
    }

    if (simple.length > 0) {
      toastSuccess(
        t('Added to cart', 'تمت الإضافة إلى السلة'),
        `${simple.length} ${t('items added to your cart', 'منتجات أضيفت إلى سلتك')}`
      );
    }

    if (needVariant.length > 0) {
      const names = needVariant
        .map(p => (isRtl ? (p.nameAr ?? p.name) : p.name))
        .join(isRtl ? '، ' : ', ');
      toastInfo(
        t(
          `${needVariant.length} item${needVariant.length > 1 ? 's' : ''} need${needVariant.length > 1 ? '' : 's'} a variant`,
          `${needVariant.length} ${needVariant.length > 1 ? 'منتجات تحتاج' : 'منتج يحتاج'} إلى اختيار نوع`
        ),
        t(
          `${names} — open each to pick a variant before adding.`,
          `${names} — افتح كل منتج لاختيار النوع قبل الإضافة.`
        )
      );
    }

    // Nothing added AND nothing flagged — defensive, shouldn't happen
    // since products.length > 0 by the guard above, but covers edge cases.
    if (simple.length === 0 && needVariant.length === 0) {
      toastError(
        t('Nothing to add', 'لا يوجد ما يضاف'),
        t('No items were available to add.', 'لا توجد منتجات متاحة للإضافة.')
      );
    }
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
