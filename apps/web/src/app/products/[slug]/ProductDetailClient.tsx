'use client';

import { pdpMaxQty } from '@/lib/b2b-moq';
import { Fragment, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { firstCategoryId, pickRelated } from '../../../lib/related-products';
import { useLocalePrice } from '../../../hooks/useLocalePrice';
import { useParams } from 'next/navigation';
import Link from '../../../components/StoreLink';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { Button, Badge, useToast } from '@ebda/ui';
import type { StoreLayoutSettings } from '@ebda/shared';
import { pageSurfaceStyle } from '@/lib/page-surface';
import {
  resolveSectionZone,
  zoneStyle,
  pageTextScale,
  pageDensityStyle,
} from '../../../templates/shared/section-typography';
import { api, type Product, type ProductVariant } from '@/lib/api';
import { getProductPricing, getDiscountBadgeText } from '@/lib/product-pricing';
import { smoothScrollLeftTo } from '@/lib/smooth-scroll';
import { useCart } from '../../../contexts/CartContext';
import { useStore, useStoreUrl, useStoreTemplate } from '../../../contexts/StoreContext';
import { useFeatures } from '../../../contexts/FeatureContext';
import { ShopChrome, SectionErrorBoundary } from '../../../components';
import {
  PageMark,
  itemNodes,
  pageSectionsAround,
  usePageDocument,
  withPageSettings,
} from '../../../builder/render/PageDocument';
import { useLanguage, translations } from '../../../contexts/LanguageContext';
import { trackViewContent, trackAddToCart } from '../../../components/MarketingPixels';
import { recordFocusProduct, getLastListing } from '@/lib/last-listing';
import { VariantSelector } from '../../../components/VariantSelector';
import { autoSelectVariant, variantWithoutPicker } from '@/lib/single-variant';
import { useTemplateComponents } from '../../../hooks/useTemplateComponents';
import { useNumerals } from '../../../hooks/useNumerals';
import { toTemplateProduct } from '../../../templates/adapters';
import { ProductCarousel } from '../../../templates/shared/ProductCarousel';
import { TaxInclusiveLabel } from '../../../templates/shared/tax-inclusive-label';
import { B2bPdpPanel } from '../../../components/pricing/B2bPdpPanel';
import { ShareProductRow } from '../../../templates/shared/ShareProductRow';
import { WaMeProductButton } from '../../../templates/shared/WaMeButtons';
import { SpecTable } from '../../../templates/shared/SpecTable';
import { OosImageDim, OutOfStockRibbon } from '../../../templates/shared/ProductCardCta';
import {
  getCustomBadgeColor,
  getCustomBadgeTextColor,
  resolveCardBadges,
} from '../../../templates/shared/custom-badge';

import { fromMinor, getLook, model3dSwatchColor } from '@ebda/shared';
import { Model3dToggle, ProductModel3dPanel } from '../../../components/ProductModel3d';
import { captureEvent } from '../../../components/PostHogProvider';
import { DahabProductDetail } from '../../../templates/dahab/ProductDetail';
import { REGION } from '@ebda/shared';
import { FactsTable } from '../../../components/commerce/FactsTable';
import { DeliveryChip } from '../../../components/commerce/DeliveryChip';
import { InstalmentLine } from '../../../components/commerce/InstalmentLine';
import {
  GOLD_STALE_NOTE_ID,
  GoldRateLine,
  useGoldRateStale,
} from '../../../components/commerce/GoldRateLine';
import { RatingSummary } from '../../../components/commerce/RatingSummary';
import { BundleSaving } from '../../../components/commerce/BundleSaving';
import { TrustLine } from '../../../components/commerce/TrustLine';
import { LOOK_CHIP_STYLE, relatedHeadingSize } from '../../../templates/shared/look-card';
import type { CodOffer } from '../../../lib/cod-offer';
import { Breadcrumbs } from '../../../components/Breadcrumbs';
import { canBuyNow, inStockNow } from '../../../lib/can-buy-now';
import { SizeChartDialog } from '../../../components/commerce/SizeChartDialog';
import { StickyAddToCart } from '../../../components/commerce/StickyAddToCart';
import {
  PersonalisationField,
  personalisationMissing,
} from '../../../components/commerce/PersonalisationField';
import { activePersonalisation, cleanNote } from '@ebda/shared';
import { countText, ITEMS } from '../../../lib/plural';
import { MinusIcon, PlusIcon } from '../../../templates/shared/icons';
import { MissingImage } from '../../../templates/shared/MissingImage';
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
        <div className="aspect-square rounded-[var(--radius)] bg-muted" />
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
  /** Server-read COD offer for the trust line (S-02); null/absent = no COD claim. */
  codOffer?: CodOffer | null;
  /** Canonical page URL from the server, for the share row. Absent -> read after hydration. */
  shareUrl?: string;
}

export default function ProductDetailClient({
  initialProduct,
  layout,
  codOffer = null,
  shareUrl,
}: ProductDetailClientProps) {
  const params = useParams();
  const slug = params?.slug as string;

  const [product, setProduct] = useState<Product | null>(initialProduct ?? null);
  const [relatedProducts, setRelatedProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(!initialProduct);
  const [error, setError] = useState<string | null>(null);
  // B2B M7: the stepper starts at the product's minimum order quantity (a retail product's is 1).
  const [quantity, setQuantity] = useState(Math.max(1, initialProduct?.moq ?? 1));
  const moqFloor = Math.max(1, product?.moq ?? 1);
  useEffect(() => {
    setQuantity(q => Math.max(q, moqFloor));
  }, [moqFloor]);
  // Per-item personalisation text (e.g. the name to embroider). Part of the cart line identity.
  const [note, setNote] = useState('');
  // Bumped when a tap on add-to-cart is blocked ONLY by the empty required note:
  // PersonalisationField then scrolls to, focuses and explains itself (no add).
  const [noteNudge, setNoteNudge] = useState(0);
  // Bumped when add-to-cart is tapped with an option still unset (C-02).
  const [optionNudge, setOptionNudge] = useState(0);
  const [selectedImage, setSelectedImage] = useState(0);
  const [isAdding, setIsAdding] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(false);
  // Selected variant from VariantSelector (null = no variant chosen or invalid combo).
  // A product with exactly one tappable variant starts with it selected — the
  // same rule VariantSelector uses for its initial pick — so the server render
  // already has Add to Cart enabled instead of flipping on after hydration.
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(() => {
    const names = (initialProduct?.options ?? []).map(o => o.name);
    return (
      autoSelectVariant(initialProduct?.variants, names) ??
      variantWithoutPicker(initialProduct?.variants, names)
    );
  });
  // Variants but no option groups: no picker will ever set a variant, so the
  // page holds one (also when the product loads client-side). Without this the
  // buy button nudged a selector that is not on the page: a dead tap.
  useEffect(() => {
    if (selectedVariant || !product) return;
    const v = variantWithoutPicker(
      product.variants,
      (product.options ?? []).map(o => o.name)
    );
    if (v) setSelectedVariant(v);
    // Keyed on the product only; selectedVariant is read to skip, not to react.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product]);

  // True once the shopper has tapped an option pill. An auto-selected single
  // variant (above) must not swap the gallery to its own image: the owner's
  // rule is that auto-selection changes nothing visible except the pill state
  // and the Add to Cart button — a tap still swaps it exactly as before.
  const [shopperPickedVariant, setShopperPickedVariant] = useState(false);
  // 3D viewer (docs/plans/2026-10-07-product-3d-viewer.md): opened by an
  // explicit tap only — nothing 3D downloads before it. `pickedOptions` is the
  // shopper's PARTIAL pick map, so "Metal: Gold" recolours before a size.
  const [show3d, setShow3d] = useState(false);
  const [pickedOptions, setPickedOptions] = useState<Record<string, string>>({});
  const galleryVariant = shopperPickedVariant ? selectedVariant : null;

  // Reset the gallery to the first image whenever the variant image changes —
  // INCLUDING when a variant is deselected (imageUrl → undefined). That also
  // prevents a stale selectedImage from pointing past the end after the `images`
  // array shrinks back (which would scroll the track into empty space).
  useEffect(() => {
    setSelectedImage(0);
  }, [galleryVariant?.imageUrl]);

  // Swipeable image gallery: the hero is a horizontal scroll-snap track showing
  // one image per "page" (swipe left/right on touch, scroll on desktop). Keep the
  // active index in sync with selectedImage so the dots + thumbnails track the
  // swipe, and smooth-scroll to the slide when the index is set externally
  // (thumbnail click / variant image).
  const galleryRef = useRef<HTMLDivElement>(null);
  // Anchor for the phone sticky add-to-cart bar: the main buy row.
  const buyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = galleryRef.current;
    if (!el) return;
    // P2-N5: the strip follows the page direction; in RTL scrollLeft runs 0 -> -max (the
    // standard every current engine ships), so the target is negative there.
    const sign = el.getAttribute('dir') === 'rtl' ? -1 : 1;
    const target = sign * el.clientWidth * selectedImage;
    if (Math.abs(el.scrollLeft - target) > 8) {
      smoothScrollLeftTo(el, target);
    }
  }, [selectedImage]);
  const handleGalleryScroll = () => {
    const el = galleryRef.current;
    if (!el || el.clientWidth === 0) return;
    const idx = Math.round(Math.abs(el.scrollLeft) / el.clientWidth);
    setSelectedImage(prev => (prev === idx ? prev : idx));
  };
  const { success: toastSuccess, error: toastError } = useToast();
  const { addItem, itemCount: cartCount } = useCart();
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
  // Related strip size: the platform card row shows 3; Dahab's row is a
  // 4-up carousel, so it asks for a fuller row (same endpoint, same rules).
  const relatedCount = templateId === 'dahab' ? 8 : 3;
  const relatedFetchLimit = templateId === 'dahab' ? '9' : '3';
  const { isEnabled } = useFeatures();
  const { language, t } = useLanguage();
  const { localize, numerals } = useNumerals();
  const formatPrice = useLocalePrice();
  // Prop layout wins (server-side fetch); ctx layout is the lazy-fetched fallback.
  // The product page's section document (Ruling VE-3): which sections go around the pinned main block.
  const pageDoc = usePageDocument('product');
  // In the editor canvas the page's own settings come from the draft document, otherwise the live layout.
  const resolvedLayout = withPageSettings(pageDoc, layout ?? ctxLayout ?? undefined);
  // The API already drops `model3d` when `product_3d` is off; the flag check
  // here is the second gate (a super-admin override takes effect client-side
  // on the next store payload too).
  const model3d = product?.model3d && isEnabled('product_3d') ? product.model3d : null;
  const model3dBindings = model3d?.bindings;
  // ONE condition for the reviews block AND the rating line that links to it (#reviews): a store
  // whose plan lacks `reviews`, or whose merchant switched the section off, shows neither.
  const reviewsOn =
    isEnabled('reviews') &&
    !!withPageSettings(pageDoc, layout)?.reviewSection?.enabled &&
    !!product &&
    !!store.id &&
    store.id !== 'demo';
  const swatchColor = useCallback(
    (optionName: string, value: string) =>
      model3dBindings ? model3dSwatchColor(model3dBindings, optionName, value) : undefined,
    [model3dBindings]
  );
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
    : { ...(pdpHeadingZone || {}), fontSize: relatedHeadingSize(store.look) };
  const pdpScale = pageTextScale(pdp?.textScale);
  const pdpDensity = pageDensityStyle(pdp?.density);
  // Decision (b), L-03 (W2a): an image-led look (`density: 'airy'`, design.md § "Image-led looks")
  // shows the gallery edge to edge below `sm`, at 4:5 unless the merchant chose a gallery aspect;
  // from `sm` it is the capped gallery every store has. Every other store is unchanged.
  const airyGallery = store?.theme?.density === 'airy';
  const merchantGalleryAspect = pdp?.imageAspect ?? resolvedLayout?.productsPage?.pdpImageAspect;
  const galleryFrameClass = airyGallery
    ? `relative ${
        !merchantGalleryAspect || merchantGalleryAspect === 'auto'
          ? 'aspect-[4/5] sm:aspect-[3/4]'
          : pdpAspectClass
      } -mx-4 w-[calc(100%+2rem)] max-w-none rounded-none sm:mx-auto sm:w-full sm:max-w-[400px] sm:rounded-[var(--radius)] lg:max-w-[600px] overflow-hidden bg-gradient-to-br from-primary/5 to-primary/10`
    : `relative ${pdpAspectClass} mx-auto max-w-[280px] sm:max-w-[400px] lg:max-w-[600px] overflow-hidden rounded-[var(--radius)] bg-gradient-to-br from-primary/5 to-primary/10`;
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
        value: fromMinor(product.price),
        currency: REGION.currency,
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
          api.getProducts({ category: catId, limit: relatedFetchLimit }).then(relResponse => {
            if (relResponse.success && relResponse.data) {
              setRelatedProducts(
                relResponse.data.products
                  .filter((p: Product) => p.id !== product.id)
                  .slice(0, relatedCount)
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
            value: fromMinor(loadedProduct.price),
            currency: REGION.currency,
          });

          // Server-side view beacon: fire alongside pixel for analytics rollup.
          if (store?.id && store.id !== 'demo') {
            const sessionId =
              typeof window !== 'undefined'
                ? (localStorage.getItem('sessionId') ?? undefined)
                : undefined;
            api.beaconProductView(store.id, loadedProduct.id, sessionId);
          }

          // Related products from the same category. Guard-and-return rather
          // than nesting: no category means nothing to relate to.
          const catId = firstCategoryId(response.data.product.categories);
          if (catId) {
            const relResponse = await api.getProducts({
              category: catId,
              limit: relatedFetchLimit,
            });
            if (relResponse.success && relResponse.data) {
              setRelatedProducts(
                pickRelated(relResponse.data.products, loadedProduct.id, relatedCount)
              );
            }
          }
        } else {
          setError(response.error?.message || t('Product not found', 'المنتج غير موجود'));
        }
      } catch {
        setError(
          t(
            'Unable to load product. Please check your connection.',
            'معرفناش نحمّل المنتج. اتأكد من اتصالك بالإنترنت.'
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
    // Optimistic toggle (mirrors CartContext.addItem) — flip immediately,
    // fire the API call, roll back on failure. No blocking gate: the UI
    // must never wait on the network round-trip to reflect the toggle.
    const wasWishlisted = isWishlisted;
    setIsWishlisted(!wasWishlisted);
    // Every shopper-facing string through t() (R-05): these toasts were English-only.
    const name = language === 'ar' && product.nameAr ? product.nameAr : product.name;
    try {
      if (wasWishlisted) {
        await api.delete(`/wishlist/product/${product.id}`);
        toastSuccess(
          t('Removed from wishlist', 'اتشال من المفضلة'),
          t(`${name} removed from your wishlist`, `شيلنا ${name} من المفضلة`)
        );
      } else {
        await api.post('/wishlist', { productId: product.id });
        toastSuccess(
          t('Added to wishlist', 'اتضاف للمفضلة'),
          t(`${name} added to your wishlist`, `ضفنا ${name} للمفضلة`)
        );
      }
    } catch {
      setIsWishlisted(wasWishlisted);
      toastError(
        t('Error', 'خطأ'),
        t('Failed to update wishlist. Please try again.', 'معرفناش نحدّث المفضلة. جرّب تاني.')
      );
    }
  };

  const handleAddToCart = async () => {
    if (!product) return;

    // An option is still unset (or the picked combination does not exist): the
    // button is NOT disabled for that (C-02) — the tap takes the shopper to the
    // first missing choice (VariantSelector `nudge`: scroll, focus, ring, live
    // text). Same path for the main button, the Dahab pinned bar and the
    // phone sticky bar, which all call this handler.
    const productVariants = product.variants ?? [];
    if (productVariants.length > 0 && !selectedVariant) {
      setOptionNudge(n => n + 1);
      return;
    }

    if (personalisationMissing(product.personalisation, note)) {
      setNoteNudge(n => n + 1);
      return;
    }

    setIsAdding(true);
    const added = await addItem(
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
        note: cleanNote(note) ?? undefined,
      },
      quantity
    );
    setIsAdding(false);

    // addItem toasts success/failure centrally. Only after a CONFIRMED add do we
    // fire the AddToCart pixel (else a failed add reports a false conversion) and
    // record the focus target for "Continue Shopping".
    if (!added) return;

    trackAddToCart({
      contentId: product.id,
      contentName: product.name,
      quantity,
      value: fromMinor(selectedVariant ? selectedVariant.price : product.price),
      currency: REGION.currency,
    });

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

  // Gold-rate pricing (B5): the piece's public gold facts for the chosen variant, and whether the rate is past
  // the store's limit by the browser clock (display only; checkout refuses with GOLD_RATE_STALE regardless).
  const goldForSelection =
    (selectedVariant ? product?.variantGoldPricing?.[selectedVariant.id] : undefined) ??
    product?.goldPricing ??
    null;
  const goldStale = useGoldRateStale(goldForSelection);

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
              'المنتج اللي بتدوّر عليه ممكن يكون اتشال أو مش موجود.'
            )}
          </p>
          <Link href={storeUrl('/products')}>
            <Button className="mt-6">{t('Browse products', 'تصفح المنتجات')}</Button>
          </Link>
        </div>
      </ShopChrome>
    );
  }

  const productImages = product.images || [];
  // When the shopper picks a variant that has its own imageUrl, swap the
  // gallery's main image to that URL by prepending a synthetic image entry.
  const images = galleryVariant?.imageUrl
    ? [
        {
          id: `variant-${galleryVariant.id}`,
          url: galleryVariant.imageUrl,
          alt: galleryVariant.name,
        },
        ...productImages.filter(img => img.url !== galleryVariant.imageUrl),
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
  // BUG 1 fix: variant-resolved badge text (EGP or pct).
  const discountBadgeText = getDiscountBadgeText(
    product,
    language === 'ar',
    displayPrice,
    displayCompare,
    numerals
  );

  // Derived inventory (variant-aware)
  const effectiveInventory = selectedVariant ? selectedVariant.inventory : product.inventory;

  // Derived add-to-cart state
  // OOS decision: with a variant selected use that variant's stock; with NO
  // variant selected use the server's aggregate `inStock` flag, NOT
  // product.inventory directly — variant products carry 0/null product-level
  // inventory (stock lives on the variants), so reading it raw made every
  // variant product's PDP either falsely show OOS or (when null) never show the
  // OOS label. The API's inStock already aggregates variant stock and respects
  // untracked inventory. (Fixed 2026-06-27.)
  //
  // ONE rule for every buy surface on this page — the selector, both buttons, the
  // sticky bars, the OOS ribbon and the delivery line (X-02/X-03): `canBuyNow`
  // (stock OR backorder). `outOfStock` is only the on-hand half, for the wording.
  const outOfStock = !inStockNow(product, selectedVariant);
  const buyableNow = canBuyNow(product, selectedVariant);
  // Backorder: when the product (or selected variant) accepts backorders, an
  // out-of-stock item stays orderable — the cart + order API already honor
  // allowBackorder (product.service.ts enrichStockFlags → acceptsBackorder).
  // The storefront previously hard-disabled Add-to-Cart at 0 inventory,
  // silently blocking the backorder feature merchants paid for (Ebda audit
  // 2026-06-14).
  const canBackorder = outOfStock && buyableNow;
  // THE add-to-cart disabled rule. Every buy button on this page (default button,
  // Dahab main + pinned bar, any sticky bar) reads this one value. A missing
  // required note is NOT a disabled reason: it is the separate `noteMissing`
  // signal, and every button's tap goes through handleAddToCart, which nudges
  // the field instead of adding (F6, the sticky bar's dead button). So a required
  // personalisation still can never be skipped by a second button.
  const noteMissing = personalisationMissing(product.personalisation, note);
  // `disabled` means the item cannot be bought (C-02). An option still to
  // choose is recoverable, so it never disables or relabels the button; the
  // tap nudges the selector instead (handleAddToCart).
  const addDisabled = !buyableNow || goldStale;
  // ONE source for the buy label and the price text: the main button, the Dahab
  // pinned bar and the default sticky bar all read these. The real verb at
  // every step: no "Select options" placeholder label.
  const addLabel = canBackorder
    ? t('Pre-order', 'اطلب مسبقاً')
    : outOfStock
      ? t('Out of stock', 'غير متوفر')
      : t('Add to cart', translations['Add to Cart']);
  // The task bar replaces the tab bar (C-04), the only phone cart entry on most
  // skins, so the bar carries its own cart link (W1a fix round, minor 3).
  const cartLinkLabel =
    cartCount > 0
      ? t(
          `Cart, ${countText('en', cartCount, ITEMS)}`,
          `السلة، ${countText('ar', cartCount, ITEMS, localize(cartCount))}`
        )
      : t('Cart', 'السلة');
  const priceText =
    pricing.mode === 'range' && minVariantPrice !== null && maxVariantPrice !== null
      ? // Y-07: English reads a range in words. Arabic reads "from" the lower price, like the cards:
        // the old "A – B" broke at the dash on a phone and left it hanging at a line end (STOP-2).
        t(
          `${formatPrice(minVariantPrice)} to ${formatPrice(maxVariantPrice)}`,
          `من ${formatPrice(minVariantPrice)}`
        )
      : formatPrice(displayPrice);
  // The sticky bar is one line: a range shows only its lower price, "From EGP 32,000".
  const stickyPriceText =
    pricing.mode === 'range' && minVariantPrice !== null
      ? t(`From ${formatPrice(minVariantPrice)}`, `من ${formatPrice(minVariantPrice)}`)
      : priceText;
  // The WhatsApp order/ask button carries the typed note and follows the SAME
  // required-personalisation gate as add-to-cart.
  const personalisationCfg = activePersonalisation(product.personalisation);
  const typedNote = cleanNote(note);
  const waPersonalisation =
    personalisationCfg && typedNote
      ? {
          // A control label inside a sentence: never the other language (F4).
          label:
            (language === 'ar' ? personalisationCfg.labelAr : personalisationCfg.label)?.trim() ||
            t('Personalisation', 'التخصيص'),
          note: typedNote,
        }
      : null;

  // Custom (merchant-authored) badge on the PDP. A badge that shows on the
  // card and then vanishes on the product's own page is the same defect as
  // not shipping it — the shopper clicks the "عرض" chip and lands on a page
  // that never mentions it.
  //
  // `discountOccupiesCorner: false`: the PDP renders both badges as inline
  // `<Badge>`s in a flex row, not as corner overlays, so they physically
  // cannot collide and the corner arm of the mutex must not fire. The
  // out-of-stock arm still applies, via the same backorder-aware `orderable`
  // signal the cards use.
  const { customBadgeText: pdpCustomBadgeText } = resolveCardBadges({
    product,
    isRtl: language === 'ar',
    orderable: buyableNow,
    customPosition: resolvedLayout?.productCardDefaults?.customBadge?.position,
    discountPosition: resolvedLayout?.productCardDefaults?.discountBadge?.position,
    discountOccupiesCorner: false,
  });
  const pdpCustomBadgeColor = getCustomBadgeColor(
    resolvedLayout?.productCardDefaults?.customBadge?.color,
    store.theme
  );
  const pdpCustomBadgeTextColor = getCustomBadgeTextColor(
    resolvedLayout?.productCardDefaults?.customBadge?.color,
    store.theme
  );

  // Below-the-fold blocks shared by every skin, one slot per document section (FAQ, reviews, frequently
  // bought together, you might also like). `null` = nothing to show; the related carousel is skin-specific.
  const upsellOn = isEnabled('upsell_crosssell') && product && store.id && store.id !== 'demo';
  const commonSlots: Record<string, ReactNode> = {
    'product-faq':
      product?.faqs && product.faqs.length > 0 ? (
        <ProductFAQSection faqs={product.faqs} language={language} t={t} />
      ) : null,
    'product-reviews':
      reviewsOn && product ? (
        <SectionErrorBoundary section="reviews">
          <ReviewSection storeId={store.id} productId={product.id} />
        </SectionErrorBoundary>
      ) : null,
    'product-bundles': upsellOn ? (
      <SectionErrorBoundary section="frequently-bought-together">
        <FrequentlyBoughtTogether storeId={store.id} productId={product.id} />
      </SectionErrorBoundary>
    ) : null,
    'product-recommendations': upsellOn ? (
      <SectionErrorBoundary section="you-might-also-like">
        <YouMightAlsoLike storeId={store.id} productId={product.id} />
      </SectionErrorBoundary>
    ) : null,
  };

  // Dahab skin: same data and handlers, Dahab presentation (templates/dahab/ProductDetail).
  if (templateId === 'dahab') {
    const retailCap =
      effectiveInventory != null && effectiveInventory > 0 ? Math.min(effectiveInventory, 10) : 10;
    // B2B M7: a MOQ or price break above the retail cap stays selectable (stock still bounds it).
    const pricedMax = pdpMaxQty(retailCap, product.moq, product.priceTiers);
    const maxQty = Math.max(
      moqFloor,
      effectiveInventory != null && effectiveInventory > 0
        ? Math.min(pricedMax, effectiveInventory)
        : pricedMax
    );
    const badges = [pdpCustomBadgeText, discountBadgeText].filter((b): b is string => !!b);
    const dahabAround = pageSectionsAround(pageDoc, {
      ...commonSlots,
      'product-related':
        relatedProducts.length > 0 && !templateLoading ? (
          <section className="py-12 sm:py-16">
            <ProductCarousel
              products={relatedProducts.map(toTemplateProduct)}
              title="You may also like"
              titleAr="قطع قد تعجبك"
              isRtl={language === 'ar'}
              currency={store.currency}
              pack={templateId}
              urlPrefix={storeUrl('')}
              showCardPrice={store.theme?.showPriceOnCards === false ? false : undefined}
              onAddToCart={async productId => {
                const found = relatedProducts.find(x => x.id === productId);
                if (found)
                  addItem({
                    id: found.id,
                    name: found.name,
                    nameAr: found.nameAr ?? undefined,
                    price: found.price,
                    slug: found.slug,
                    image: found.images?.[0]?.url,
                    category: found.categories?.[0]?.category?.name,
                  });
              }}
            />
          </section>
        ) : null,
    });
    // The skin keeps its container: consecutive blocks share one `max-w-7xl` wrapper, the related
    // strip stands alone (the default order renders exactly the markup it did before documents).
    const dahabGroups = (items: typeof dahabAround.after) => {
      const out: ReactNode[] = [];
      let run: ReactNode[] = [];
      const flush = () => {
        if (run.length === 0) return;
        out.push(
          <div key={`run-${out.length}`} className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {run}
          </div>
        );
        run = [];
      };
      for (const it of items) {
        if (it.type === 'product-related') {
          flush();
          out.push(<Fragment key={it.id}>{it.node}</Fragment>);
        } else run.push(it.node);
      }
      flush();
      return out;
    };
    return (
      <ShopChrome layout={resolvedLayout}>
        <div className="flex-1" style={pdpBgStyle}>
          {dahabGroups(dahabAround.before)}
          <PageMark kind="product">
            <DahabProductDetail
              ratingLine={
                reviewsOn ? (
                  <RatingSummary
                    average={product.ratingStats?.ratingAverage}
                    count={product.ratingStats?.ratingCount}
                  />
                ) : undefined
              }
              bundleLine={<BundleSaving productId={product.id} />}
              priceNote={
                <GoldRateLine
                  gold={goldForSelection}
                  className="mt-1"
                  staleId={GOLD_STALE_NOTE_ID}
                />
              }
              b2bPanel={
                <B2bPdpPanel
                  productId={product.id}
                  variantId={selectedVariant?.id ?? null}
                  moq={product.moq}
                  tiers={product.priceTiers}
                />
              }
              images={images}
              name={displayName}
              categoryName={categoryName ?? undefined}
              categoryHref={
                cat0?.category?.slug
                  ? storeUrl(`/products?category=${cat0.category.slug}`)
                  : undefined
              }
              homeHref={storeUrl('/')}
              productsHref={storeUrl('/products')}
              shippingHref={storeUrl('/shipping')}
              returnsHref={storeUrl('/returns')}
              codOffer={codOffer}
              excerpt={displayExcerpt}
              description={displayDescription}
              priceText={priceText}
              compareText={
                pricing.mode === 'single' && displayCompare && displayCompare > displayPrice
                  ? formatPrice(displayCompare)
                  : null
              }
              badges={badges}
              variants={productVariants}
              options={productOptions}
              onVariantSelect={setSelectedVariant}
              onShopperSelect={() => setShopperPickedVariant(true)}
              quantity={quantity}
              setQuantity={setQuantity}
              maxQuantity={maxQty}
              minQuantity={moqFloor}
              stockText={
                outOfStock && !canBackorder
                  ? t('Out of stock', 'مش متوفر دلوقتي')
                  : canBackorder
                    ? t('Made to order — ships when ready', 'بيتعمل مخصوص — بيتشحن أول ما يجهز')
                    : null
              }
              onAddToCart={handleAddToCart}
              isAdding={isAdding}
              addDisabled={addDisabled}
              addDescribedBy={goldStale ? GOLD_STALE_NOTE_ID : undefined}
              personalisation={product.personalisation}
              note={note}
              onNoteChange={setNote}
              noteNudge={noteNudge}
              optionNudge={optionNudge}
              addLabel={
                canBackorder
                  ? t('Pre-order', 'طلب مسبق')
                  : outOfStock
                    ? t('Out of stock', 'غير متوفر')
                    : t('Add to bag', 'إضافة للسلة')
              }
              cartHref={storeUrl('/cart')}
              cartCount={cartCount}
              cartLabel={cartLinkLabel}
              isWishlisted={isWishlisted}
              onToggleWishlist={handleToggleWishlist}
              sku={product.sku}
              facts={product.facts}
              leadTimeDays={product.leadTimeDays}
              sizeChart={product.sizeChart}
              specs={
                (product as { specifications?: unknown }).specifications ? (
                  <SpecTable
                    specifications={
                      (product as { specifications?: unknown }).specifications as
                        | Record<string, string>
                        | undefined
                    }
                  />
                ) : undefined
              }
              extras={
                <>
                  <WaMeProductButton
                    product={product}
                    priceMinor={displayPrice}
                    className="w-full"
                    personalisation={waPersonalisation}
                    disabled={noteMissing}
                    onBlocked={() => setNoteNudge(n => n + 1)}
                  />
                  <ShareProductRow productName={displayName} url={shareUrl} />
                </>
              }
              // Ruling B5-1 (finding): the Dahab branch never passed `mediaSlot`, so a Dahab product
              // with a 3D model showed no viewer. Same toggle + panel the default PDP renders, same
              // flag and model gate; a product without a model renders nothing.
              mediaSlot={
                model3d ? (
                  <div className="relative mt-4" data-part="model3d-slot">
                    <Model3dToggle
                      active={show3d}
                      t={t}
                      onToggle={() => {
                        if (!show3d) {
                          captureEvent('product_3d_opened', {
                            storeId: store?.id,
                            productId: product.id,
                          });
                        }
                        setShow3d(v => !v);
                      }}
                    />
                    {show3d ? (
                      <ProductModel3dPanel
                        model={model3d}
                        storeId={store?.id ?? ''}
                        productId={product.id}
                        productName={displayName}
                        fallbackPoster={productImages[0]?.url}
                        selected={pickedOptions}
                        optionOrder={productOptions.map(o => o.name)}
                        isRtl={language === 'ar'}
                        t={t}
                      />
                    ) : (
                      <div aria-hidden="true" className="h-14" />
                    )}
                  </div>
                ) : undefined
              }
              selectedImage={selectedImage}
              onSelectImage={setSelectedImage}
            />
          </PageMark>
          {dahabGroups(dahabAround.after)}
        </div>
      </ShopChrome>
    );
  }

  const around = pageSectionsAround(pageDoc, {
    ...commonSlots,
    'product-related':
      relatedProducts.length > 0 && !templateLoading ? (
        <div className="mt-16">
          {/* Compact horizontal carousel (was a 2/3-col grid of full-size cards). Reuses the
              canonical ProductCarousel so the related strip is smaller + scrollable + matches the
              homepage strips, and honours the per-store PDP heading typography zone. */}
          <ProductCarousel
            products={relatedProducts.map(toTemplateProduct)}
            title="You may also like"
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
              store.theme?.showPriceOnCards === false ? false : productCardDefaults?.showCardPrice
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
      ) : null,
  });

  return (
    <ShopChrome layout={resolvedLayout}>
      {/* Whole product detail page — gallery + info + variants +
          related-products + frequently-bought-together — falls under
          the merchant's "Products" typography zone. The flex-1 wrapper
          carries the per-store product-detail page background. */}
      <div className="flex-1" style={pdpBgStyle}>
        <div
          className={`mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 ${airyGallery ? 'pb-8 sm:py-8' : 'py-8'}`}
          style={pdpDensity}
          data-zone="products"
        >
          {itemNodes(around.before)}
          <PageMark kind="product">
            {/* Breadcrumb. Hidden below md (C-04): on a phone the fold is gallery, title,
              price, the first selector and the buy button; the trail pushes them down. */}
            <Breadcrumbs
              className="mb-8 hidden text-sm md:block"
              items={[
                { label: t('Home', translations['Home']), href: storeUrl('/') },
                { label: t('Products', translations['Products']), href: storeUrl('/products') },
                // Category segment: back to the PLP filtered to the primary category.
                ...(categoryName && cat0?.category?.slug
                  ? [
                      {
                        label: categoryName,
                        href: storeUrl(`/products?category=${cat0.category.slug}`),
                      },
                    ]
                  : []),
                { label: displayName },
              ]}
            />

            {/* Product Details */}
            <div className="grid gap-8 md:grid-cols-12">
              {/* Images */}
              <div className="space-y-4 md:col-span-5 md:sticky md:top-24 md:self-start">
                <div className={galleryFrameClass} data-gallery={airyGallery ? 'airy' : undefined}>
                  {model3d && (
                    <Model3dToggle
                      active={show3d}
                      t={t}
                      onToggle={() => {
                        if (!show3d) {
                          captureEvent('product_3d_opened', {
                            storeId: store?.id,
                            productId: product.id,
                          });
                        }
                        setShow3d(v => !v);
                      }}
                    />
                  )}
                  {model3d && show3d ? (
                    <ProductModel3dPanel
                      model={model3d}
                      storeId={store?.id ?? ''}
                      productId={product.id}
                      productName={displayName}
                      fallbackPoster={productImages[0]?.url}
                      selected={pickedOptions}
                      optionOrder={productOptions.map(o => o.name)}
                      isRtl={language === 'ar'}
                      t={t}
                    />
                  ) : images.length > 0 ? (
                    // Swipeable scroll-snap track — one image per page. Touch users
                    // swipe left/right; desktop scrolls/drag. handleGalleryScroll
                    // keeps selectedImage (dots + thumbnails) in sync.
                    <div
                      ref={galleryRef}
                      onScroll={handleGalleryScroll}
                      // a11y re-audit P2-N5: the strip reads in the page direction, so in Arabic
                      // photo 2 lies to the LEFT, where Next (inline end) and ArrowLeft point. It was
                      // dir=ltr to keep scrollLeft positive; the scroll math now takes |scrollLeft|
                      // and a signed target instead (RTL scrollLeft is 0 -> -max in every engine).
                      dir={language === 'ar' ? 'rtl' : 'ltr'}
                      // P1-7 (W4): a named, focusable region; arrow keys page it like the buttons.
                      role="region"
                      aria-roledescription="carousel"
                      aria-label={t(`Photos of ${displayName}`, `صور ${displayName}`)}
                      tabIndex={0}
                      onKeyDown={e => {
                        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                        e.preventDefault();
                        const forward = (e.key === 'ArrowLeft') === (language === 'ar');
                        setSelectedImage(i =>
                          Math.min(images.length - 1, Math.max(0, i + (forward ? 1 : -1)))
                        );
                      }}
                      className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      {images.map((img, index) => (
                        <div
                          key={img.id || index}
                          className={`relative h-full w-full shrink-0 snap-center${img.id?.startsWith('variant-') ? ' variant-image-fade' : ''}`}
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
                    <MissingImage
                      label={language === 'ar' && product.nameAr ? product.nameAr : product.name}
                      size="lg"
                    />
                  )}
                  {/* Out-of-stock label + image dim — same platform OOS system as
                    the product cards (productCardDefaults oosLabel + oosDimColor),
                    so the PDP matches the listing. orderable honors backorder:
                    a backorder-able OOS product is still orderable so no label.
                    Sits OVER the swipe track so it stays put while images scroll. */}
                  {!show3d && (
                    <OosImageDim
                      orderable={buyableNow}
                      oosDimColor={productCardDefaults?.oosDimColor}
                      theme={store?.theme}
                    />
                  )}
                  <OutOfStockRibbon
                    flat={!!getLook(store.look)}
                    inStock={buyableNow}
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
                  {/* P1-7 / AT-2 (W4): real prev/next buttons, 44px, at the inline edges, plus a
                    polite status line; the dots below stay as the visual position cue. */}
                  {images.length > 1 && !show3d && (
                    <>
                      <button
                        type="button"
                        data-gallery-prev
                        disabled={selectedImage === 0}
                        onClick={() => setSelectedImage(i => Math.max(0, i - 1))}
                        aria-label={t('Previous photo', 'الصورة السابقة')}
                        className="absolute start-2 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-[var(--radius)] bg-background/85 text-foreground disabled:opacity-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <svg
                          className="h-5 w-5 rtl:-scale-x-100"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 19l-7-7 7-7"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        data-gallery-next
                        disabled={selectedImage >= images.length - 1}
                        onClick={() => setSelectedImage(i => Math.min(images.length - 1, i + 1))}
                        aria-label={t('Next photo', 'الصورة التالية')}
                        className="absolute end-2 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-[var(--radius)] bg-background/85 text-foreground disabled:opacity-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <svg
                          className="h-5 w-5 rtl:-scale-x-100"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </button>
                      <span data-gallery-status className="sr-only" aria-live="polite">
                        {t(
                          `Photo ${selectedImage + 1} of ${images.length}`,
                          `الصورة ${selectedImage + 1} من ${images.length}`
                        )}
                      </span>
                    </>
                  )}
                  {/* Dot indicators — current image of total. */}
                  {images.length > 1 && !show3d && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
                      {images.map((_, i) => (
                        <span
                          key={i}
                          className={`h-1.5 rounded-full transition-[width,background-color] ${
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
                {/* The category chip moved below the buy block (taste bar: on a 390px phone
                  the fold is gallery, title, price, selectors, personalisation, add to cart,
                  delivery chip, and nothing more). Only the merchant's own badge, the
                  discount and the draft marker stay up here, and only when one exists. */}
                {(pdpCustomBadgeText || discountBadgeText || product.status === 'draft') && (
                  <div className="mb-4 flex items-center gap-2">
                    {/* Custom badge — the merchant's own words, same chip the
                    product cards show. Inline color so a merchant's
                    productCardDefaults.customBadge.color carries onto the PDP
                    instead of the badge silently reverting to the primary
                    token here. */}
                    {pdpCustomBadgeText && (
                      <Badge
                        className="text-white"
                        style={{
                          backgroundColor: pdpCustomBadgeColor,
                          color: pdpCustomBadgeTextColor,
                        }}
                      >
                        {pdpCustomBadgeText}
                      </Badge>
                    )}
                    {/* Discount badge — BUG 1 fix: helper text (EGP or pct).
                    Waits for variant selection on variant products
                    (displayCompare is null until a variant is picked). */}
                    {discountBadgeText &&
                      (getLook(store.look) ? (
                        // a look's sale chip is its own accent / metal, never the error red (B2-25)
                        <span
                          className="inline-flex items-center rounded-[var(--radius)] px-2.5 py-1 text-xs font-semibold"
                          style={LOOK_CHIP_STYLE}
                        >
                          {discountBadgeText}
                        </span>
                      ) : (
                        <Badge variant="destructive">{discountBadgeText}</Badge>
                      ))}
                    {product.status === 'draft' && (
                      <Badge variant="outline">{t('Draft', 'مسودة')}</Badge>
                    )}
                  </div>
                )}

                {/* PDP NAME-vs-PRICE rule: name carries the zone that drives size; price
                  mirrors the zone on its own span (not the parent div) so the Tailwind
                  size class on the child cannot win over the parent's inline fontSize.
                  Hardcoded text-3xl / text-2xl removed — size is purely zone-driven.
                  See design.md § "PDP name ≥ price invariant". */}
                <h1
                  className="font-bold text-foreground [overflow-wrap:anywhere]"
                  data-zone="productName"
                  style={zoneStyle(pdpNameZone, pdpScale)}
                >
                  {displayName}
                </h1>

                {/* Phase B3 (Ruling B3-6): one inline rating line; renders nothing without a rating. */}
                {reviewsOn && (
                  <RatingSummary
                    average={product.ratingStats?.ratingAverage}
                    count={product.ratingStats?.ratingCount}
                  />
                )}

                {displayExcerpt && (
                  <p className="mt-2 whitespace-pre-line text-base text-muted-foreground">
                    {displayExcerpt}
                  </p>
                )}

                {/* Price */}
                <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span
                    // one price never splits from its currency; only an English "A to B" range may wrap
                    className={`font-bold text-primary${pricing.mode !== 'range' || language === 'ar' ? ' whitespace-nowrap' : ''}`}
                    data-zone="productPrice"
                    style={zoneStyle(pdpPriceZone, pdpScale)}
                  >
                    {priceText}
                  </span>
                  {pricing.mode === 'single' && displayCompare && displayCompare > displayPrice && (
                    <span className="text-lg text-muted-foreground line-through">
                      {formatPrice(displayCompare)}
                    </span>
                  )}
                  {/* B2-9: merchant-configured estimate, PDP only; renders nothing when off. */}
                  <InstalmentLine priceMinor={displayPrice} buyable={buyableNow} />
                </div>
                <TaxInclusiveLabel className="mt-1 block text-xs text-muted-foreground" />
                <GoldRateLine
                  gold={goldForSelection}
                  className="mt-1"
                  staleId={GOLD_STALE_NOTE_ID}
                />
                {/* Phase B3 (Ruling B3-6): one live bundle-saving line; renders nothing without a saving. */}
                <BundleSaving productId={product.id} />
                <B2bPdpPanel
                  productId={product.id}
                  variantId={selectedVariant?.id ?? null}
                  moq={product.moq}
                  tiers={product.priceTiers}
                />

                {/* Variant Selector */}
                {hasVariants && hasOptions ? (
                  <VariantSelector
                    variants={productVariants}
                    options={productOptions}
                    onVariantSelect={setSelectedVariant}
                    onShopperSelect={() => setShopperPickedVariant(true)}
                    onSelectionChange={setPickedOptions}
                    nudge={optionNudge}
                    swatchColor={model3d ? swatchColor : undefined}
                    sizeGuide={
                      product.sizeChart ? <SizeChartDialog chart={product.sizeChart} /> : undefined
                    }
                  />
                ) : (
                  // No selector to sit beside: the guide gets its own line (renders nothing without a chart).
                  <SizeChartDialog chart={product.sizeChart} className="mt-4" />
                )}

                <PersonalisationField
                  config={product.personalisation}
                  value={note}
                  onChange={setNote}
                  nudge={noteNudge}
                />

                {/* Quantity & Add to Cart */}
                <div className="mt-8 space-y-4">
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium text-foreground">
                      {t('Quantity', 'الكمية')}:
                    </span>
                    <div className="flex items-center rounded-lg border border-input">
                      <button
                        type="button"
                        onClick={() => setQuantity(Math.max(moqFloor, quantity - 1))}
                        aria-label={t('Decrease quantity', 'تقليل الكمية')}
                        // a11y re-audit P2-N11: no quantity to choose when it cannot be bought.
                        disabled={!buyableNow || goldStale}
                        className="flex h-11 min-w-11 items-center justify-center px-4 text-muted-foreground hover:bg-muted cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <MinusIcon />
                      </button>
                      <span aria-live="polite" className="w-12 text-center font-medium">
                        {localize(quantity)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const retailCap =
                            effectiveInventory != null && effectiveInventory > 0
                              ? Math.min(effectiveInventory, 10)
                              : 10;
                          // A MOQ or price break above the retail cap must be selectable (stock still bounds it).
                          const maxQty = pdpMaxQty(retailCap, product?.moq, product?.priceTiers);
                          const stockCap =
                            effectiveInventory != null && effectiveInventory > 0
                              ? Math.min(maxQty, effectiveInventory)
                              : maxQty;
                          setQuantity(Math.min(quantity + 1, Math.max(stockCap, moqFloor)));
                        }}
                        aria-label={t('Increase quantity', 'زيادة الكمية')}
                        disabled={!buyableNow || goldStale}
                        className="flex h-11 min-w-11 items-center justify-center px-4 text-muted-foreground hover:bg-muted cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <PlusIcon />
                      </button>
                    </div>
                    {effectiveInventory !== undefined &&
                      effectiveInventory !== null &&
                      outOfStock && (
                        <span className="text-sm text-muted-foreground">
                          {/* From the same stock answer as the button (X-02): a variant
                          product's own inventory is 0, and a pre-order is not "out".
                          Taste re-audit P2-1: "in stock" is true for almost every item, so
                          only pre-order and out of stock are said (quality bar § 8). */}
                          {canBackorder
                            ? t('Available to pre-order', 'متاح للطلب المسبق')
                            : t('Out of stock', 'غير متوفر')}
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

                  <div className="flex gap-4" ref={buyRef}>
                    <Button
                      size="lg"
                      className="flex-1"
                      data-testid="pdp-add"
                      onClick={handleAddToCart}
                      isLoading={isAdding}
                      disabled={addDisabled}
                      aria-describedby={goldStale ? GOLD_STALE_NOTE_ID : undefined}
                    >
                      {addLabel}
                    </Button>

                    <Button
                      size="lg"
                      variant="outline"
                      onClick={handleToggleWishlist}
                      aria-label={t('Save to wishlist', 'حفظ في المفضلة')}
                      aria-pressed={isWishlisted}
                    >
                      <svg
                        aria-hidden="true"
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
                  {/* X-03: a delivery date only for something that can be bought now. */}
                  {buyableNow && <DeliveryChip leadTimeDays={product.leadTimeDays} />}
                  {/* S-02: COD · return window, from the store's own settings. */}
                  <TrustLine cod={codOffer} />
                </div>

                {/* Below the buy block: the category chip and the description (fold rule above). */}
                {/* L-08: on phones (no breadcrumb below md) the category is a link back to its PLP;
                  from md the breadcrumb carries it, so no second, unlinked label. */}
                {categoryName && cat0?.category?.slug && (
                  <div className="mt-6 md:hidden">
                    <Link
                      href={storeUrl(`/products?category=${cat0.category.slug}`)}
                      className="inline-flex min-h-11 min-w-11 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {categoryName}
                    </Link>
                  </div>
                )}
                {displayDescription && (
                  // whitespace-pre-line: the admin edits this in a <Textarea>, so
                  // a merchant's line breaks are stored — but HTML collapses
                  // them, which ran every paragraph together into one block and
                  // read as "only the first line saved". Matches how FAQ answers
                  // and how-to guides already render merchant prose. Still plain
                  // text (React escapes it), so no HTML injection surface.
                  <p className="mt-4 max-w-prose whitespace-pre-line text-muted-foreground leading-relaxed">
                    {displayDescription}
                  </p>
                )}

                {/* SKU */}
                {product.sku && (
                  <div className="mt-6 border-t border-border pt-6">
                    <p className="text-sm text-muted-foreground">SKU: {product.sku}</p>
                  </div>
                )}

                {/* Spec rows: below the buy box on purpose (PDP above-the-fold budget). */}
                <FactsTable facts={product.facts} />

                <WaMeProductButton
                  product={product}
                  priceMinor={displayPrice}
                  className="mt-6 w-full sm:w-auto"
                  personalisation={waPersonalisation}
                  disabled={noteMissing}
                  onBlocked={() => setNoteNudge(n => n + 1)}
                />
                <ShareProductRow
                  productName={language === 'ar' && product.nameAr ? product.nameAr : product.name}
                  url={shareUrl}
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
          </PageMark>
          {itemNodes(around.after)}
        </div>
      </div>
      {/* Phone sticky bar: SAME handler + SAME addDisabled/label as the main button. */}
      <StickyAddToCart
        anchorRef={buyRef}
        title={displayName}
        price={stickyPriceText}
        label={addLabel}
        disabled={addDisabled || isAdding}
        onAdd={handleAddToCart}
        cartHref={storeUrl('/cart')}
        cartCount={cartCount}
        cartCountText={localize(cartCount)}
        cartLabel={cartLinkLabel}
      />
    </ShopChrome>
  );
}
