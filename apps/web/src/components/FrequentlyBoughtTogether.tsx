'use client';

import { useState, useEffect } from 'react';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore, useStoreUrl, useStoreTemplate } from '../contexts/StoreContext';
import { useToast } from '@force/ui';
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
  /** Variants of this product (added 2026-05-16 to gate Add-all-to-cart
   *  for variant-parent products). Empty / missing = simple SKU. */
  variants?: Array<{ id: string; price: number }>;
}

interface FrequentlyBoughtTogetherProps {
  storeId: string;
  productId: string;
}

export function FrequentlyBoughtTogether({ storeId, productId }: FrequentlyBoughtTogetherProps) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { addItem, items: cartItems } = useCart();
  const { language, t } = useLanguage();
  const { store, layout } = useStore();
  const storeUrl = useStoreUrl();
  const templateId = useStoreTemplate();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const isRtl = language === 'ar';
  // Honour the same per-store productCardDefaults as the PLP and homepage
  // carousels so frame/size/shape settings apply on this surface too.
  // Eliminates the T.ProductGrid 4th render path: these cards now go through
  // PecannbeeProductCard (same path as PLP and catalog listings).
  const productCardDefaults = layout?.productCardDefaults;

  // Variant-parent products can't be added to cart silently from a
  // recommendation card. Helper shared by single-add and add-all.
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

  if (isLoading || products.length === 0) return null;

  const cartQuantities: Record<string, number> = {};
  for (const item of cartItems) cartQuantities[item.productId] = item.quantity;

  const handleAddToCart = async (pid: string) => {
    const p = products.find(x => x.id === pid);
    if (!p) return;
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
    // Add-to-cart toast is centralized in CartContext.addItem (Group E).
  };

  const handleAddAllToCart = async () => {
    const simple = products.filter(p => !hasVariants(p));
    const needVariant = products.filter(p => hasVariants(p));

    // Sequential awaits so each addItem sees the post-previous-add cart state.
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

    if (simple.length === 0 && needVariant.length === 0) {
      toastError(
        t('Nothing to add', 'لا يوجد ما يضاف'),
        t('No items were available to add.', 'لا توجد منتجات متاحة للإضافة.')
      );
    }
  };

  return (
    <div className="mt-16">
      {/* Issue 3 fix (2026-05-28): flex-wrap + gap-3 prevents the heading
          and CTA button from overlapping on narrow RTL mobile viewports.
          shrink-0 on the button keeps it from squishing. LTR unaffected. */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-foreground">
          {t('Frequently Bought Together', 'يُشترى معاً في الغالب')}
        </h2>
        <button
          onClick={handleAddAllToCart}
          className="shrink-0 rounded-xl border border-primary px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
        >
          {t('Add All to Cart', 'أضف الكل إلى السلة')}
        </button>
      </div>
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
              variants: p.variants,
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
