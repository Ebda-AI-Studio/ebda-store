'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { Button, Badge, useToast } from '@force/ui';
import type { StoreLayoutSettings } from '@force/shared';
import { pageSurfaceStyle } from '@/lib/page-surface';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../../templates/shared/section-typography';
import { api, type Product, type ProductVariant } from '@/lib/api';
import { getProductPricing, getDiscountBadgeText } from '@/lib/product-pricing';
import { useCart } from '../../../contexts/CartContext';
import { useStore, useStoreUrl, useStoreTemplate } from '../../../contexts/StoreContext';
import { useFeatures } from '../../../contexts/FeatureContext';
import { ShopChrome, SectionErrorBoundary } from '../../../components';
import { useLanguage, translations } from '../../../contexts/LanguageContext';
import { trackViewContent, trackAddToCart } from '../../../components/MarketingPixels';
import { recordFocusProduct, getLastListing } from '@/lib/last-listing';
import { VariantSelector } from '../../../components/VariantSelector';
import { useTemplateComponents } from '../../../hooks/useTemplateComponents';
import { useNumerals } from '../../../hooks/useNumerals';
import { toTemplateProduct } from '../../../templates/adapters';
import { ProductCarousel } from '../../../templates/shared/ProductCarousel';
import { TaxInclusiveLabel } from '../../../templates/shared/tax-inclusive-label';
import { ShareProductRow } from '../../../templates/shared/ShareProductRow';
import { SpecTable } from '../../../templates/shared/SpecTable';
import { OosImageDim, OutOfStockRibbon } from '../../../templates/shared/ProductCardCta';
import { formatPrice as formatPriceBase } from '@/lib/format';

// Lazy-load heavy below-the-fold components to reduce initial bundle size
const ReviewSection = dynamic(() => import('../../../components/ReviewSection'), { ssr: false });
const FrequentlyBoughtTogether = dynamic(() =>
  import('../../../components/FrequentlyBoughtTogether').then(mod => ({
    default: mod.FrequentlyBoughtTogether,
  }))
);
const YouMightAlsoLike = dynamic(() =>
  import('../../../components/YouMightAlsoLike').then(mod => ({ default: mod.YouMightAlsoLike }))
);

interface ProductFAQ {
  id: string;
  question: string;
  questionAr?: string | null;
  answer: string;
  answerAr?: string | null;
}

function ProductFAQSection({
  faqs,
  language,
  t,
}: {
  faqs: ProductFAQ[];
  language: string;
  t: (en: string, ar: string) => string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const isAr = language === 'ar';

  return (
    <section aria-labelledby="product-faq-heading" className="mt-16">
      <h2 id="product-faq-heading" className="mb-6 text-2xl font-bold text-foreground">
        {t('Product Q&A', 'أسئلة وأجوبة المنتج')}
      </h2>
      <div className="space-y-3">
        {/* Show at most 3 FAQs — keeps the PDP focused and avoids a wall of
            (sometimes redundant) auto-drafted Q&A below the product. */}
        {faqs.slice(0, 3).map((faq, index) => {
          const question = isAr ? faq.questionAr || faq.question : faq.question;
          const answer = isAr ? faq.answerAr || faq.answer : faq.answer;
          return (
            <div key={faq.id} className="rounded-xl border bg-card shadow-sm">
              <button
                type="button"
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                aria-expanded={openIndex === index}
                className="flex w-full items-center justify-between p-5 text-left"
              >
                <span className="font-medium text-foreground">{question}</span>
                <svg
                  className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${
                    openIndex === index ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {openIndex === index && (
                <div className="border-t px-5 py-4">
                  <p className="whitespace-pre-line text-muted-foreground">{answer}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProductSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-2 animate-pulse">
      <div className="space-y-4">
        <div className="aspect-square rounded-2xl bg-muted" />
      </div>
      <div className="space-y-4">
        <div className="h-6 w-24 rounded bg-muted" />
        <div className="h-8 w-3/4 rounded bg-muted" />
        <div className="h-10 w-40 rounded bg-muted" />
        <div className="h-20 w-full rounded bg-muted" />
        <div className="h-12 w-full rounded bg-muted" />
      </div>
    </div>
  );
}

interface ProductDetailClientProps {
  initialProduct?: Product | null;
  layout?: StoreLayoutSettings;
}

export default function ProductDetailClient({ initialProduct, layout }: ProductDetailClientProps) {
  const params = useParams();
  const slug = params?.slug as string;

  const [product, setProduct] = useState<Product | null>(initialProduct ?? null);
  const [relatedProducts, setRelatedProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(!initialProduct);
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [selectedImage, setSelectedImage] = useState(0);
  const [isAdding, setIsAdding] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(false);
  const [isTogglingWishlist, setIsTogglingWishlist] = useState(false);
  // Selected variant from VariantSelector (null = no variant chosen or invalid combo)
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);

  // Reset the gallery to the first image whenever the variant image changes —
  // INCLUDING when a variant is deselected (imageUrl → undefined). That also
  // prevents a stale selectedImage from pointing past the end after the `images`
  // array shrinks back (which would scroll the track into empty space).
  useEffect(() => {
    setSelectedImage(0);
  }, [selectedVariant?.imageUrl]);

  // Swipeable image gallery: the hero is a horizontal scroll-snap track showing
  // one image per "page" (swipe left/right on touch, scroll on desktop). Keep the
  // active index in sync with selectedImage so the dots + thumbnails track the
  // swipe, and smooth-scroll to the slide when the index is set externally
  // (thumbnail click / variant image).
  const galleryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = galleryRef.current;
    if (!el) return;
    const target = el.clientWidth * selectedImage;
    if (Math.abs(el.scrollLeft - target) > 8) {
      el.scrollTo({ left: target, behavior: 'smooth' });
    }
  }, [selectedImage]);
  const handleGalleryScroll = () => {
    const el = galleryRef.current;
    if (!el || el.clientWidth === 0) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setSelectedImage(prev => (prev === idx ? prev : idx));
  };
  const { success: toastSuccess, error: toastError } = useToast();
  const { addItem } = useCart();
  // Issue 1 fix (2026-05-28): destructure ctxLayout so we can merge it
  // with the server-side prop layout and forward to ShopChrome — the footer
  // bgColor (and other chrome overrides) were not applied on the PDP because
  // the layout prop was never forwarded to ShopChrome before this fix.
  const { store, layout: ctxLayout } = useStore();
  const storeUrl = useStoreUrl();
  const templateId = useStoreTemplate();
  // useTemplateComponents is kept for its loading state — used to gate the
  // related-products render so cards don't flash before hydration.
  const { isLoading: templateLoading } = useTemplateComponents();
  const { isEnabled } = useFeatures();
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  // Locale-aware wrapper so Arabic-locale shoppers see Arabic-Indic digits
  // (formatPriceBase defaults to Western digits when no locale is passed).
  const formatPrice = (amount: number) =>
    formatPriceBase(amount, {
      locale: language === 'ar' && store?.theme?.arabicNumerals === true ? 'ar' : 'en',
    });
  // Prop layout wins (server-side fetch); ctx layout is the lazy-fetched fallback.
  const resolvedLayout = layout ?? ctxLayout ?? undefined;
  // Issue 2: pass productCardDefaults to all card surfaces on this page.
  const productCardDefaults = resolvedLayout?.productCardDefaults;

  // Product-detail page design (page-builder → Product detail page). Image
  // aspect now lives on productDetailPage; fall back to the deprecated
  // productsPage.pdpImageAspect for any value saved before the split.
  const pdp = resolvedLayout?.productDetailPage;
  const pdpAspectClass = (() => {
    const v = pdp?.imageAspect ?? resolvedLayout?.productsPage?.pdpImageAspect;
    // Default to 3:4 portrait (canonical product image spec per design.md).
    // Explicit 'square' or 'auto' (legacy) use square mode; all other values map
    // to their named aspect. This matches the 600×800 Image dimensions below.
    if (v === 'square') return 'aspect-square';
    if (!v || v === 'auto') return 'aspect-[3/4]';
    if (v === 'portrait') return 'aspect-[3/4]';
    if (v === 'landscape') return 'aspect-[4/3]';
    if (v === 'wide') return 'aspect-[3/2]';
    if (v === 'ultrawide') return 'aspect-[16/9]';
    return 'aspect-[3/4]'; // safe fallback
  })();
  const pdpHeadingZone = resolveSectionZone(pdp?.typography?.heading, undefined, store.theme);
  // Related strip ("You May Also Like") sits below the homepage section-heading
  // scale: cap it at ~20px (text-xl) unless the merchant set a PDP heading zone.
  const relatedHeadingZone = pdpHeadingZone?.fontSize
    ? pdpHeadingZone
    : { ...(pdpHeadingZone || {}), fontSize: '20px' };
  const pdpScale = pageTextScale(pdp?.textScale);
  const pdpDensity = pageDensityStyle(pdp?.density);
  const pdpNameZone = resolveSectionZone(pdp?.typography?.productName, undefined, store.theme);
  const pdpPriceZone = resolveSectionZone(pdp?.typography?.productPrice, undefined, store.theme);
  const pdpBgStyle = pageSurfaceStyle(pdp?.bgColor, store.theme, pdp?.colorScheme);

  useEffect(() => {
    if (!slug) return;

    // If we already have the product from server-side props, just fire the
    // pixel event and fetch related products without re-fetching the product.
    if (initialProduct && product) {
      trackViewContent({
        contentId: product.id,
        contentName: product.name,
        contentCategory: product.categories?.[0]?.category?.name,
        value: product.price / 1000,
        currency: 'KWD',
      });

      // Fire server-side view beacon alongside the marketing pixel event.
      // Debounced per (sessionId, productId) for 10 min in the service.
      // store.id is available from StoreContext; guard against 'demo' sentinel.
      if (store?.id && store.id !== 'demo') {
        const sessionId =
          typeof window !== 'undefined'
            ? (localStorage.getItem('sessionId') ?? undefined)
            : undefined;
        api.beaconProductView(store.id, product.id, sessionId);
      }

      // Fetch related products
      const categories = product.categories;
      if (categories && categories.length > 0) {
        const catId = categories[0].category?.id;
        if (catId) {
          api.getProducts({ category: catId, limit: '3' }).then(relResponse => {
            if (relResponse.success && relResponse.data) {
              setRelatedProducts(
                relResponse.data.products.filter((p: Product) => p.id !== product.id).slice(0, 3)
              );
            }
          });
        }
      }
      return;
    }

    async function fetchProduct() {
      setIsLoading(true);
      setError(null);
      try {
        const response = await api.getProduct(slug);
        if (response.success && response.data) {
          const loadedProduct = response.data.product;
          setProduct(loadedProduct);

          // Fire ViewContent pixel event when product data is ready
          trackViewContent({
            contentId: loadedProduct.id,
            contentName: loadedProduct.name,
            contentCategory: loadedProduct.categories?.[0]?.category?.name,
            value: loadedProduct.price / 1000,
            currency: 'KWD',
          });

          // Server-side view beacon: fire alongside pixel for analytics rollup.
          if (store?.id && store.id !== 'demo') {
            const sessionId =
              typeof window !== 'undefined'
                ? (localStorage.getItem('sessionId') ?? undefined)
                : undefined;
            api.beaconProductView(store.id, loadedProduct.id, sessionId);
          }

          // Fetch related products from the same category
          const categories = response.data.product.categories;
          if (categories && categories.length > 0) {
            const catId = categories[0].category.id;
            if (catId) {
              const relResponse = await api.getProducts({ category: catId, limit: '3' });
              if (relResponse.success && relResponse.data) {
                setRelatedProducts(
                  relResponse.data.products
                    .filter((p: Product) => p.id !== response.data!.product.id)
                    .slice(0, 3)
                );
              }
            }
          }
        } else {
          setError(response.error?.message || t('Product not found', 'المنتج غير موجود'));
        }
      } catch {
        setError(
          t(
            'Unable to load product. Please check your connection.',
            'تعذر تحميل المنتج. يرجى التحقق من اتصالك بالإنترنت.'
          )
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchProduct();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const handleToggleWishlist = async () => {
    if (!product) return;
    setIsTogglingWishlist(true);
    try {
      if (isWishlisted) {
        await api.delete(`/wishlist/product/${product.id}`);
        setIsWishlisted(false);
        toastSuccess('Removed from wishlist', `${product.name} removed from your wishlist`);
      } else {
        await api.post('/wishlist', { productId: product.id });
        setIsWishlisted(true);
        toastSuccess('Added to wishlist', `${product.name} added to your wishlist`);
      }
    } catch {
      toastError('Error', 'Failed to update wishlist. Please try again.');
    } finally {
      setIsTogglingWishlist(false);
    }
  };

  const handleAddToCart = async () => {
    if (!product) return;

    // If this product has variants and no variant is selected yet, prompt the user
    const productVariants = product.variants ?? [];
    if (productVariants.length > 0 && !selectedVariant) {
      toastSuccess('Select options', 'Please select all options before adding to cart');
      return;
    }

    setIsAdding(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    addItem(
      {
        id: product.id,
        name: product.name,
        nameAr: product.nameAr ?? undefined,
        // Use variant price when a variant is selected
        price: selectedVariant ? selectedVariant.price : product.price,
        slug: product.slug,
        image: product.images?.[0]?.url,
        category: product.categories?.[0]?.category?.name,
        // Pass the variantId so the backend can track the correct SKU
        variantId: selectedVariant?.id,
      },
      quantity
    );
    // Fire AddToCart pixel event
    trackAddToCart({
      contentId: product.id,
      contentName: product.name,
      quantity,
      value: (selectedVariant ? selectedVariant.price : product.price) / 1000,
      currency: 'KWD',
    });

    setIsAdding(false);
    // Add-to-cart toast is fired centrally by CartContext.addItem so we
    // don't double-toast on the PDP. Same elsewhere — see Group E.

    // Record the focus target so "Continue Shopping" lands the shopper
    // ON this product's card in the PLP and highlights it briefly.
    // Derive the back-listing path: prefer the already-stored last-listing
    // (set when shopper came from the PLP), or fall back to the primary
    // category URL so the button always has something sensible to navigate to.
    const existingListing = getLastListing(store?.id);
    const categorySlug = product.categories?.[0]?.category?.slug;
    const fallbackListing = categorySlug ? `/products?category=${categorySlug}` : '/products';
    recordFocusProduct(store?.id, product.id, existingListing ?? fallbackListing);
  };

  if (isLoading) {
    return (
      <ShopChrome layout={resolvedLayout}>
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 flex-1">
          <ProductSkeleton />
        </div>
      </ShopChrome>
    );
  }

  if (error || !product) {
    return (
      <ShopChrome layout={resolvedLayout}>
        <div className="mx-auto max-w-7xl px-4 py-16 text-center flex-1">
          <h1 className="text-2xl font-bold text-foreground">
            {error || t('Product not found', 'المنتج غير موجود')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              "The product you're looking for may have been removed or doesn't exist.",
              'المنتج الذي تبحث عنه ربما تم إزالته أو غير موجود.'
            )}
          </p>
          <Link href={storeUrl('/products')}>
            <Button className="mt-6">{t('Browse Products', 'تصفح المنتجات')}</Button>
          </Link>
        </div>
      </ShopChrome>
    );
  }

  const productImages = product.images || [];
  // When the shopper picks a variant that has its own imageUrl, swap the
  // gallery's main image to that URL by prepending a synthetic image entry.
  const images = selectedVariant?.imageUrl
    ? [
        {
          id: `variant-${selectedVariant.id}`,
          url: selectedVariant.imageUrl,
          alt: selectedVariant.name,
        },
        ...productImages.filter(img => img.url !== selectedVariant.imageUrl),
      ]
    : productImages;
  const cat0 = product.categories?.[0];
  const categoryNameEn = cat0?.category?.name;
  const categoryNameAr = cat0?.category?.nameAr;
  const categoryName = language === 'ar' && categoryNameAr ? categoryNameAr : categoryNameEn;
  // Localized product name for breadcrumb / heading / image alt.
  const displayName = language === 'ar' && product.nameAr ? product.nameAr : product.name;
  // Localized description — the PDP previously hard-rendered the English
  // `description` regardless of locale, so a balanced Arabic description never
  // showed on the AR storefront. Prefer descriptionAr on the AR site.
  const displayDescription =
    language === 'ar' && product.descriptionAr ? product.descriptionAr : product.description;
  // Short 1-2 sentence blurb (bulk-ai-excerpt sweep or manual) — a compact
  // summary rendered near the title, distinct from the full description
  // below. Same locale-fallback convention as displayDescription.
  const displayExcerpt =
    language === 'ar' && product.excerptAr ? product.excerptAr : product.excerpt;

  // Derived variant/option availability
  const productVariants = product.variants ?? [];
  const productOptions = product.options ?? [];
  const hasVariants = productVariants.length > 0;
  const hasOptions = productOptions.length > 0;

  // Variant-aware pricing
  const pricing = getProductPricing(product, selectedVariant, 'detail');
  const { displayPrice, displayCompare, minVariantPrice, maxVariantPrice } = pricing;
  // BUG 1 fix: variant-resolved badge text (KWD or pct).
  const discountBadgeText = getDiscountBadgeText(
    product,
    language === 'ar',
    displayPrice,
    displayCompare
  );

  // Derived inventory (variant-aware)
  const effectiveInventory = selectedVariant ? selectedVariant.inventory : product.inventory;

  // Derived add-to-cart state
  const variantRequired = hasVariants && !selectedVariant;
  // OOS decision: with a variant selected use that variant's stock; with NO
  // variant selected use the server's aggregate `inStock` flag, NOT
  // product.inventory directly — variant products carry 0/null product-level
  // inventory (stock lives on the variants), so reading it raw made every
  // variant product's PDP either falsely show OOS or (when null) never show the
  // OOS label. The API's inStock already aggregates variant stock and respects
  // untracked inventory. (Fixed 2026-06-27.)
  const outOfStock = selectedVariant ? selectedVariant.inventory === 0 : product.inStock === false;
  // Backorder: when the product (or selected variant) accepts backorders, an
  // out-of-stock item stays orderable — the cart + order API already honor
  // allowBackorder (product.service.ts enrichStockFlags → acceptsBackorder).
  // The storefront previously hard-disabled Add-to-Cart at 0 inventory,
  // silently blocking the backorder feature merchants paid for (FWB audit
  // 2026-06-14).
  const canBackorder =
    outOfStock &&
    (selectedVariant ? selectedVariant.acceptsBackorder : product.acceptsBackorder) === true;

  return (
    <ShopChrome layout={resolvedLayout}>
      {/* Whole product detail page — gallery + info + variants +
          related-products + frequently-bought-together — falls under
          the merchant's "Products" typography zone. The flex-1 wrapper
          carries the per-store product-detail page background. */}
      <div className="flex-1" style={pdpBgStyle}>
        <div
          className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
          style={pdpDensity}
          data-zone="products"
        >
          {/* Breadcrumb */}
          <nav className="mb-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href={storeUrl('/')} className="hover:text-primary">
              {t('Home', translations['Home'])}
            </Link>
            <span>/</span>
            <Link
              href={storeUrl('/products')}
              className="hover:text-primary flex items-center gap-1"
            >
              <svg
                className={`h-3.5 w-3.5 ${language === 'ar' ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              {t('Products', translations['Products'])}
            </Link>
            <span>/</span>
            {/* Category segment — links back to the PLP filtered to this
                product's primary category (home / products / <category> /
                <product>). Locale-aware label; only renders when the product
                has a category. */}
            {categoryName && cat0?.category?.slug && (
              <>
                <Link
                  href={storeUrl(`/products?category=${cat0.category.slug}`)}
                  className="hover:text-primary"
                >
                  {categoryName}
                </Link>
                <span>/</span>
              </>
            )}
            <span className="text-foreground">{displayName}</span>
          </nav>

          {/* Product Details */}
          <div className="grid gap-8 md:grid-cols-12">
            {/* Images */}
            <div className="space-y-4 md:col-span-5">
              <div
                className={`relative ${pdpAspectClass} mx-auto max-w-[280px] sm:max-w-[400px] lg:max-w-[600px] overflow-hidden rounded-2xl bg-gradient-to-br from-primary/5 to-primary/10`}
              >
                {images.length > 0 ? (
                  // Swipeable scroll-snap track — one image per page. Touch users
                  // swipe left/right; desktop scrolls/drag. handleGalleryScroll
                  // keeps selectedImage (dots + thumbnails) in sync.
                  <div
                    ref={galleryRef}
                    onScroll={handleGalleryScroll}
                    // dir="ltr" even on the Arabic (RTL) storefront: the gallery
                    // is a sequence of images (not text), so left-to-right order is
                    // correct, AND it keeps scrollLeft positive (0→max) in every
                    // browser. Without it, RTL makes scrollLeft go negative in
                    // Chrome/Firefox, so the index math + scroll-to break and the
                    // gallery desyncs / scrolls into empty space for AR shoppers.
                    dir="ltr"
                    className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  >
                    {images.map((img, index) => (
                      <div
                        key={img.id || index}
                        className="relative h-full w-full shrink-0 snap-center"
                      >
                        <Image
                          src={img.url}
                          alt={img.alt || `${displayName} ${index + 1}`}
                          width={600}
                          height={800}
                          className="h-full w-full object-cover"
                          sizes="(max-width: 768px) 100vw, (max-width: 1024px) 40vw, 32vw"
                          priority={index === 0}
                          draggable={false}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="mx-auto flex h-40 w-40 items-center justify-center rounded-full bg-primary/20">
                      <svg
                        className="h-20 w-20 text-primary"
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
                {/* Out-of-stock label + image dim — same platform OOS system as
                    the product cards (productCardDefaults oosLabel + oosDimColor),
                    so the PDP matches the listing. orderable honors backorder:
                    a backorder-able OOS product is still orderable so no label.
                    Sits OVER the swipe track so it stays put while images scroll. */}
                <OosImageDim
                  orderable={!outOfStock || canBackorder}
                  oosDimColor={productCardDefaults?.oosDimColor}
                  theme={store?.theme}
                />
                <OutOfStockRibbon
                  inStock={!outOfStock || canBackorder}
                  isRtl={language === 'ar'}
                  oosLabel={productCardDefaults?.oosLabel}
                  oosLabelTextEn={productCardDefaults?.oosLabelTextEn}
                  oosLabelTextAr={productCardDefaults?.oosLabelTextAr}
                  oosLabelShape={productCardDefaults?.oosLabelShape}
                  oosLabelPlacement={productCardDefaults?.oosLabelPlacement}
                  oosLabelColor={productCardDefaults?.oosLabelColor}
                  oosLabelTextColor={productCardDefaults?.oosLabelTextColor}
                  theme={store?.theme}
                />
                {/* Dot indicators — current image of total. */}
                {images.length > 1 && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
                    {images.map((_, i) => (
                      <span
                        key={i}
                        className={`h-1.5 rounded-full transition-all ${
                          i === selectedImage ? 'w-4 bg-primary' : 'w-1.5 bg-foreground/30'
                        }`}
                      />
                    ))}
                  </div>
                )}
              </div>
              {/* Thumbnail strip removed — swipe track + dot indicators replace it. */}
            </div>

            {/* Product Info */}
            <div className="md:col-span-7">
              <div className="mb-4 flex items-center gap-2">
                {categoryName && <Badge variant="secondary">{categoryName}</Badge>}
                {/* Discount badge — BUG 1 fix: helper text (KWD or pct).
                    Waits for variant selection on variant products
                    (displayCompare is null until a variant is picked). */}
                {discountBadgeText && <Badge variant="destructive">{discountBadgeText}</Badge>}
                {product.status === 'draft' && (
                  <Badge variant="outline">{t('Draft', 'مسودة')}</Badge>
                )}
              </div>

              {/* PDP NAME-vs-PRICE rule: name carries the zone that drives size; price
                  mirrors the zone on its own span (not the parent div) so the Tailwind
                  size class on the child cannot win over the parent's inline fontSize.
                  Hardcoded text-3xl / text-2xl removed — size is purely zone-driven.
                  See design.md § "PDP name ≥ price invariant". */}
              <h1
                className="font-bold text-foreground"
                data-zone="productName"
                style={zoneStyle(pdpNameZone, pdpScale)}
              >
                {displayName}
              </h1>

              {displayExcerpt && (
                <p className="mt-2 text-base text-muted-foreground">{displayExcerpt}</p>
              )}

              {/* Price */}
              <div className="mt-4 flex items-baseline gap-3">
                <span
                  className="font-bold text-primary"
                  data-zone="productPrice"
                  style={zoneStyle(pdpPriceZone, pdpScale)}
                >
                  {pricing.mode === 'range' && minVariantPrice !== null && maxVariantPrice !== null
                    ? `${formatPrice(minVariantPrice)} – ${formatPrice(maxVariantPrice)}`
                    : formatPrice(displayPrice)}
                </span>
                {pricing.mode === 'single' && displayCompare && displayCompare > displayPrice && (
                  <span className="text-lg text-muted-foreground line-through">
                    {formatPrice(displayCompare)}
                  </span>
                )}
              </div>
              <TaxInclusiveLabel className="mt-1 block text-xs text-muted-foreground" />

              {displayDescription && (
                <p className="mt-6 max-w-prose text-muted-foreground leading-relaxed">
                  {displayDescription}
                </p>
              )}

              {/* Variant Selector */}
              {hasVariants && hasOptions && (
                <VariantSelector
                  variants={productVariants}
                  options={productOptions}
                  onVariantSelect={setSelectedVariant}
                />
              )}

              {/* Quantity & Add to Cart */}
              <div className="mt-8 space-y-4">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-foreground">
                    {t('Quantity', 'الكمية')}:
                  </span>
                  <div className="flex items-center rounded-lg border border-border">
                    <button
                      type="button"
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                      aria-label={t('Decrease quantity', 'تقليل الكمية')}
                      className="flex h-11 min-w-11 items-center justify-center px-4 text-muted-foreground hover:bg-muted cursor-pointer"
                    >
                      -
                    </button>
                    <span aria-live="polite" className="w-12 text-center font-medium">
                      {localize(quantity)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const maxQty =
                          effectiveInventory != null && effectiveInventory > 0
                            ? Math.min(effectiveInventory, 10)
                            : 10;
                        setQuantity(Math.min(quantity + 1, maxQty));
                      }}
                      aria-label={t('Increase quantity', 'زيادة الكمية')}
                      className="flex h-11 min-w-11 items-center justify-center px-4 text-muted-foreground hover:bg-muted cursor-pointer"
                    >
                      +
                    </button>
                  </div>
                  {effectiveInventory !== undefined && effectiveInventory !== null && (
                    <span className="text-sm text-muted-foreground">
                      {effectiveInventory > 0
                        ? t('In Stock', 'متوفر')
                        : t('Out of Stock', 'غير متوفر')}
                    </span>
                  )}
                </div>
                {/* BUG 2 fix: discount badge stacked directly below the OOS
                    indicator row when product is out of stock (and not
                    backorderable). This surfaces the saving alongside the
                    stock state rather than only in the title area. */}
                {outOfStock && !canBackorder && discountBadgeText && (
                  <div>
                    <Badge variant="destructive">{discountBadgeText}</Badge>
                  </div>
                )}

                <div className="flex gap-4">
                  <Button
                    size="lg"
                    className="flex-1"
                    onClick={handleAddToCart}
                    isLoading={isAdding}
                    disabled={(outOfStock && !canBackorder) || variantRequired}
                  >
                    {variantRequired
                      ? t('Select Options', 'اختر الخيارات')
                      : canBackorder
                        ? t('Pre-order', 'اطلب مسبقاً')
                        : outOfStock
                          ? t('Out of Stock', 'غير متوفر')
                          : t('Add to Cart', translations['Add to Cart'])}
                  </Button>

                  <Button
                    size="lg"
                    variant="outline"
                    onClick={handleToggleWishlist}
                    disabled={isTogglingWishlist}
                    aria-label={isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                  >
                    <svg
                      className="h-5 w-5"
                      fill={isWishlisted ? 'currentColor' : 'none'}
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                      />
                    </svg>
                  </Button>
                </div>
              </div>

              {/* SKU */}
              {product.sku && (
                <div className="mt-6 border-t border-border pt-6">
                  <p className="text-sm text-muted-foreground">SKU: {product.sku}</p>
                </div>
              )}

              <ShareProductRow
                productName={language === 'ar' && product.nameAr ? product.nameAr : product.name}
                url={typeof window !== 'undefined' ? window.location.href : ''}
                className="mt-6 border-t border-border pt-6"
              />
              <SpecTable
                specifications={
                  (product as { specifications?: unknown }).specifications as
                    | Record<string, string>
                    | undefined
                }
                className="mt-6"
              />
            </div>
          </div>

          {/* Product FAQ */}
          {product?.faqs && product.faqs.length > 0 && (
            <ProductFAQSection faqs={product.faqs} language={language} t={t} />
          )}

          {/* Product Reviews — gated on BOTH the platform feature flag
            AND the per-store layout toggle. Default for new stores is
            enabled=false so a brand-new store does not show a placeholder. */}
          {isEnabled('reviews') &&
            layout?.reviewSection?.enabled &&
            product &&
            store.id &&
            store.id !== 'demo' && (
              <SectionErrorBoundary section="reviews">
                <ReviewSection storeId={store.id} productId={product.id} />
              </SectionErrorBoundary>
            )}

          {/* Upsell / Cross-sell recommendations — each section isolated so a
              render error in one doesn't take down the other or the rest of
              the PDP (Lens M graceful degradation). */}
          {isEnabled('upsell_crosssell') && product && store.id && store.id !== 'demo' && (
            <>
              <SectionErrorBoundary section="frequently-bought-together">
                <FrequentlyBoughtTogether storeId={store.id} productId={product.id} />
              </SectionErrorBoundary>
              <SectionErrorBoundary section="you-might-also-like">
                <YouMightAlsoLike storeId={store.id} productId={product.id} />
              </SectionErrorBoundary>
            </>
          )}

          {/* Related Products — compact ProductCarousel (canonical card via
            getPackStyles) so per-store productCardDefaults (frame, size, shape)
            are honoured here too. Eliminates the T.ProductGrid 4th render path
            on the PDP per the standing platform rule. */}
          {relatedProducts.length > 0 && !templateLoading && (
            <div className="mt-16">
              {/* Compact horizontal carousel (was a 2/3-col grid of full-size
                  cards). Reuses the canonical ProductCarousel so the related
                  strip is smaller + scrollable + matches the homepage strips,
                  and honours the per-store PDP heading typography zone. */}
              <ProductCarousel
                products={relatedProducts.map(toTemplateProduct)}
                title="You May Also Like"
                titleAr="قد يعجبك أيضاً"
                headingZone={relatedHeadingZone}
                isRtl={language === 'ar'}
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
                  store.theme?.showPriceOnCards === false
                    ? false
                    : productCardDefaults?.showCardPrice
                }
                urlPrefix={storeUrl('')}
                onAddToCart={async productId => {
                  const found = relatedProducts.find(x => x.id === productId);
                  if (found)
                    addItem({
                      id: found.id,
                      name: found.name,
                      price: found.price,
                      slug: found.slug,
                      image: found.images?.[0]?.url,
                      category: found.categories?.[0]?.category?.name,
                    });
                }}
              />
            </div>
          )}
        </div>
      </div>
    </ShopChrome>
  );
}
