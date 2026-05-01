'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { Button, Badge, useToast } from '@force/ui';
import { api, type Product, type ProductVariant } from '@/lib/api';
import { getProductPricing } from '@/lib/product-pricing';
import { useCart } from '../../../contexts/CartContext';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useFeatures } from '../../../contexts/FeatureContext';
import { ShopChrome } from '../../../components';
import { useLanguage, translations } from '../../../contexts/LanguageContext';
import { trackViewContent, trackAddToCart } from '../../../components/MarketingPixels';
import { VariantSelector } from '../../../components/VariantSelector';
import { useTemplateComponents } from '../../../hooks/useTemplateComponents';
import { toTemplateProduct } from '../../../templates/adapters';
import { TaxInclusiveLabel } from '../../../templates/shared/tax-inclusive-label';
import { formatPrice } from '@/lib/format';

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

function ProductSkeleton() {
  return (
    <div className="grid gap-8 lg:grid-cols-2 animate-pulse">
      <div className="space-y-4">
        <div className="aspect-square rounded-2xl bg-muted" />
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map(i => (
            <div key={i} className="aspect-square rounded-lg bg-muted" />
          ))}
        </div>
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
}

export default function ProductDetailClient({ initialProduct }: ProductDetailClientProps) {
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

  // When the selected variant changes to one with its own imageUrl, jump the
  // gallery to index 0 so the variant image is the active hero immediately.
  // Reverting to no variant (or one without imageUrl) leaves the user on
  // whichever product image they were already browsing.
  useEffect(() => {
    if (selectedVariant?.imageUrl) {
      setSelectedImage(0);
    }
  }, [selectedVariant?.imageUrl]);
  const { success: toastSuccess, error: toastError } = useToast();
  const { addItem } = useCart();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const { isEnabled } = useFeatures();
  const { language, t } = useLanguage();

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
          setError(response.error?.message || 'Product not found');
        }
      } catch {
        setError('Unable to load product. Please check your connection.');
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
        await api.delete(`/wishlist/${product.id}`);
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
  };

  if (isLoading) {
    return (
      <ShopChrome>
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 flex-1">
          <ProductSkeleton />
        </div>
      </ShopChrome>
    );
  }

  if (error || !product) {
    return (
      <ShopChrome>
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
  // When the shopper picks a variant that has its own `imageUrl`, swap the
  // gallery's main image to that URL by prepending a synthetic image entry.
  // Deselecting the variant (selectedVariant === null) reverts to the
  // product's original image set with no extra cleanup needed — we never
  // mutate productImages, only derive `images`.
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
  // Localized product name for breadcrumb / heading / image alt. Falls
  // through to English when nameAr isn't supplied for this SKU.
  const displayName = language === 'ar' && product.nameAr ? product.nameAr : product.name;

  // Derived variant/option availability
  const productVariants = product.variants ?? [];
  const productOptions = product.options ?? [];
  const hasVariants = productVariants.length > 0;
  const hasOptions = productOptions.length > 0;

  // Variant-aware pricing — see lib/product-pricing.ts for the rules.
  // The shared helper guarantees the same behaviour across the detail
  // page, list view, and the three template-grid cards. Detail-page
  // surface uses `range` for un-selected variant products (the customer
  // is already on the page; show the full spread before they pick).
  const pricing = getProductPricing(product, selectedVariant, 'detail');
  const { displayPrice, displayCompare, minVariantPrice, maxVariantPrice } = pricing;

  // Derived inventory (variant-aware)
  const effectiveInventory = selectedVariant ? selectedVariant.inventory : product.inventory;

  // Derived add-to-cart state
  const variantRequired = hasVariants && !selectedVariant;
  const outOfStock = effectiveInventory === 0;

  return (
    <ShopChrome>
      {/* Whole product detail page — gallery + info + variants +
          related-products + frequently-bought-together — falls under
          the merchant's "Products" typography zone. */}
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 flex-1" data-zone="products">
        {/* Breadcrumb */}
        <nav className="mb-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={storeUrl('/')} className="hover:text-primary">
            {t('Home', translations['Home'])}
          </Link>
          <span>/</span>
          <Link href={storeUrl('/products')} className="hover:text-primary flex items-center gap-1">
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
          <span className="text-foreground">{displayName}</span>
        </nav>

        {/* Product Details */}
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Images */}
          <div className="space-y-4">
            <div className="aspect-square overflow-hidden rounded-2xl bg-gradient-to-br from-primary/5 to-primary/10">
              {images[selectedImage]?.url ? (
                <Image
                  src={images[selectedImage].url}
                  alt={images[selectedImage].alt || displayName}
                  width={800}
                  height={800}
                  className="h-full w-full object-cover"
                  sizes="(max-width: 1024px) 100vw, 50vw"
                  priority
                />
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
            </div>
            {images.length > 1 && (
              <div className="grid grid-cols-4 gap-4">
                {images.map((img, index) => (
                  <button
                    key={img.id || index}
                    type="button"
                    onClick={() => setSelectedImage(index)}
                    aria-label={`Select image ${index + 1} of ${images.length}`}
                    aria-pressed={selectedImage === index}
                    className={`aspect-square overflow-hidden rounded-lg transition ${
                      selectedImage === index
                        ? 'ring-2 ring-primary'
                        : 'hover:ring-2 hover:ring-border'
                    }`}
                  >
                    <Image
                      src={img.url}
                      alt={img.alt || `${displayName} ${index + 1}`}
                      width={200}
                      height={200}
                      className="h-full w-full object-cover"
                      sizes="25vw"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Product Info */}
          <div>
            <div className="mb-4 flex items-center gap-2">
              {categoryName && <Badge variant="secondary">{categoryName}</Badge>}
              {/* Discount badge only when there's a CONCRETE compare-at to
                  compare against. For products with variants we wait for
                  the customer to pick one before deciding whether to flag
                  a discount — the parent's own compareAtPrice is usually
                  stale data from before the variant fold and would
                  produce a fake "X% OFF" badge. */}
              {displayCompare && displayCompare > displayPrice && (
                <Badge variant="destructive">
                  {Math.round((1 - displayPrice / displayCompare) * 100)}% OFF
                </Badge>
              )}
              {product.status === 'draft' && <Badge variant="outline">{t('Draft', 'مسودة')}</Badge>}
            </div>

            <h1 className="text-3xl font-bold text-foreground">{displayName}</h1>

            {/* Price — see lib/product-pricing.ts:
                  - selected variant: that variant's price + compareAt
                  - hasVariants no-selection on detail page: "min – max"
                  - all-variant prices identical: single number
                  - no variants: parent's price + compareAt */}
            <div className="mt-4 flex items-baseline gap-3">
              <span className="text-3xl font-bold text-primary">
                {pricing.mode === 'range' && minVariantPrice !== null && maxVariantPrice !== null
                  ? `${formatPrice(minVariantPrice)} – ${formatPrice(maxVariantPrice)}`
                  : formatPrice(displayPrice)}
              </span>
              {pricing.mode === 'single' && displayCompare && displayCompare > displayPrice && (
                <span className="text-xl text-muted-foreground line-through">
                  {formatPrice(displayCompare)}
                </span>
              )}
            </div>
            <TaxInclusiveLabel className="mt-1 block text-xs text-muted-foreground" />

            {product.description && (
              <p className="mt-6 text-muted-foreground leading-relaxed">{product.description}</p>
            )}

            {/* Variant Selector -- rendered when the API returns variants and options */}
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
                    className="px-4 py-2 text-muted-foreground hover:bg-muted cursor-pointer"
                  >
                    -
                  </button>
                  <span aria-live="polite" className="w-12 text-center font-medium">
                    {quantity}
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
                    className="px-4 py-2 text-muted-foreground hover:bg-muted cursor-pointer"
                  >
                    +
                  </button>
                </div>
                {effectiveInventory !== undefined && effectiveInventory !== null && (
                  <span className="text-sm text-muted-foreground">
                    {/* Customers don't need to see exact stock counts —
                        "99 متوفر" reads like a low-stock urgency cue at
                        glance and felt off to the merchant. Just say
                        "in stock" / "out of stock". */}
                    {effectiveInventory > 0
                      ? t('In Stock', 'متوفر')
                      : t('Out of Stock', 'غير متوفر')}
                  </span>
                )}
              </div>

              <div className="flex gap-4">
                <Button
                  size="lg"
                  className="flex-1"
                  onClick={handleAddToCart}
                  isLoading={isAdding}
                  disabled={outOfStock || variantRequired}
                >
                  {outOfStock
                    ? t('Out of Stock', 'غير متوفر')
                    : variantRequired
                      ? t('Select Options', 'اختر الخيارات')
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
          </div>
        </div>

        {/* Product Reviews */}
        {isEnabled('reviews') && product && store.id && store.id !== 'demo' && (
          <ReviewSection storeId={store.id} productId={product.id} />
        )}

        {/* Upsell / Cross-sell recommendations */}
        {isEnabled('upsell_crosssell') && product && store.id && store.id !== 'demo' && (
          <>
            <FrequentlyBoughtTogether storeId={store.id} productId={product.id} />
            <YouMightAlsoLike storeId={store.id} productId={product.id} />
          </>
        )}

        {/* Related Products */}
        {relatedProducts.length > 0 && T && !templateLoading && (
          <div className="mt-16">
            <h2 className="text-2xl font-bold text-foreground mb-6">
              {t('Related Products', 'منتجات ذات صلة')}
            </h2>
            <T.ProductGrid
              products={relatedProducts.map(toTemplateProduct)}
              isRtl={language === 'ar'}
              currency={store.currency}
              columns={3}
              urlPrefix={storeUrl('')}
            />
          </div>
        )}
      </div>
    </ShopChrome>
  );
}
