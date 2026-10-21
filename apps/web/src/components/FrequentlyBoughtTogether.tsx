'use client';

import { pickLocalizedName } from '../templates/shared/display-helpers';
import { canBuyNow } from '@/lib/can-buy-now';
import { useProductRecommendations, selectCrossSell } from '../hooks/useProductRecommendations';
import { recommendedToTemplateProduct, needsOptions } from '../templates/adapters';
import { useCart } from '../contexts/CartContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStore, useStoreUrl, useStoreTemplate } from '../contexts/StoreContext';
import { useToast, Skeleton, SkeletonProductCard } from '@ebda/ui';
import { PecannbeeProductCard } from '../templates/shared/PecannbeeProductCard';
import { gridGapClass } from '../templates/shared/card-size';
import { SectionRetryNotice } from './SectionRetryNotice';
import { countText, ITEMS_ADDED, ITEMS_NEED_OPTIONS } from '../lib/plural';

/** Loading placeholder matching the grid this section renders once data
 *  resolves — avoids the pop-in layout shift the previous `return null`
 *  caused while `isLoading` was true. */
function FrequentlyBoughtTogetherSkeleton() {
  return (
    <div className="mt-16" aria-hidden="true">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {[1, 2, 3, 4].map(i => (
          <SkeletonProductCard key={i} />
        ))}
      </div>
    </div>
  );
}

interface FrequentlyBoughtTogetherProps {
  storeId: string;
  productId: string;
}

export function FrequentlyBoughtTogether({ storeId, productId }: FrequentlyBoughtTogetherProps) {
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
  // recommendation card (the cart API refuses it: VARIANT_REQUIRED). The
  // shared rule, so the button and the card agree.
  const hasVariants = needsOptions;

  const { products, status, refetch } = useProductRecommendations(
    storeId,
    productId,
    selectCrossSell
  );

  if (status === 'loading') return <FrequentlyBoughtTogetherSkeleton />;
  if (status === 'error') {
    return (
      <div className="mt-16">
        <SectionRetryNotice
          onRetry={refetch}
          message="Couldn't load Frequently Bought Together."
          messageAr="معرفناش نحمّل قسم «بيتشروا مع بعض»."
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
    if (hasVariants(p)) {
      toastInfo(
        t('Choose a variant first', 'اختار نوع المنتج الأول'),
        t(
          `"${p.name}" has options — open the product to pick one.`,
          `"${pickLocalizedName(p, true) ?? p.name}" ليه اختيارات — افتح المنتج واختار النوع.`
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
    // Sold-out pieces (no backorder) are left out: the card shows them sold
    // out, so "add all" must not try them and toast a refusal.
    const orderable = products.filter(p => canBuyNow(p));
    const simple = orderable.filter(p => !hasVariants(p));
    const needVariant = orderable.filter(p => hasVariants(p));

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
        t('Added to cart', 'اتضاف للسلة'),
        t(countText('en', simple.length, ITEMS_ADDED), countText('ar', simple.length, ITEMS_ADDED))
      );
    }

    if (needVariant.length > 0) {
      const names = needVariant
        .map(p => pickLocalizedName(p, isRtl) ?? p.name)
        .join(isRtl ? '، ' : ', ');
      toastInfo(
        t(
          countText('en', needVariant.length, ITEMS_NEED_OPTIONS),
          countText('ar', needVariant.length, ITEMS_NEED_OPTIONS)
        ),
        t(
          `${names} — open each to pick a variant before adding.`,
          `${names} — افتح كل منتج واختار نوعه قبل ما تضيفه.`
        )
      );
    }

    if (simple.length === 0 && needVariant.length === 0) {
      toastError(
        t('Nothing to add', 'مفيش حاجة تتضاف'),
        t('No items were available to add.', 'مفيش منتجات متاحة تتضاف.')
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
            product={recommendedToTemplateProduct(p)}
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
            cardImageAspect={productCardDefaults?.cardImageAspect}
            cardImageRadius={productCardDefaults?.cardImageRadius}
            showCardName={productCardDefaults?.showCardName}
            showCardPrice={
              store.theme?.showPriceOnCards === false ? false : productCardDefaults?.showCardPrice
            }
            urlPrefix={storeUrl('')}
            onAddToCart={handleAddToCart}
          />
        ))}
      </div>
    </div>
  );
}
