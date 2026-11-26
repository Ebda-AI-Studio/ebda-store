'use client';

/**
 * `product-spotlight` (builder Phase 3 pilot, document-only): one editorial
 * photograph beside a short list of products ("Gift ideas"). The image side
 * is logical (start = right in Arabic). Products resolve like the grids.
 */
import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import type { SectionPaddingMaxWidthVisibility } from '@ebda/shared';
import { sanitizeUrl } from '@ebda/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { displayedImageKey, imageMarker } from '../render/image-key';
import { getProductPricing } from '../../lib/product-pricing';
import { canBuyNow } from '../../lib/can-buy-now';
import { isInCompareList, toggleCompare } from '../../lib/compare';
import { FactChips } from '../../components/commerce/FactChips';
import { Model3dChip } from '../../components/commerce/Model3dChip';
import { soldOutLabel } from '../../templates/shared/ProductCardCta';
import type { TemplateProduct } from '../../templates/types';
import type { SectionProductRefs } from './section-products';

export interface ProductSpotlightSettings
  extends SectionPaddingMaxWidthVisibility, SectionProductRefs {
  image?: string;
  imageAr?: string;
  alt?: string;
  altAr?: string;
  heading?: string;
  headingAr?: string;
  body?: string;
  bodyAr?: string;
  imagePosition?: 'start' | 'end';
  /** `stage` = ONE product on a large object-contain tile (Phase B2); absent/`list` = photo + list. */
  layout?: 'list' | 'stage';
  buttonText?: string;
  buttonTextAr?: string;
  buttonLink?: string;
  bgColor?: string;
}

export function ProductSpotlightSection({
  settings,
  products,
  editorMode = false,
  onAddToCart,
  priority = false,
  showPrice = true,
}: {
  settings: ProductSpotlightSettings;
  products: TemplateProduct[];
  editorMode?: boolean;
  /** The stage's add control (the same handler every card path gets). Absent = view link only. */
  onAddToCart?: (productId: string) => Promise<void>;
  /** Only the FIRST stage on a page is the LCP candidate; later ones load lazily. */
  priority?: boolean;
  /** The store's card-price switch (`showPriceOnCards` / `showCardPrice`): false hides every price. */
  showPrice?: boolean;
}) {
  if (settings.layout === 'stage') {
    return (
      <SpotlightStage
        settings={settings}
        product={products[0]}
        editorMode={editorMode}
        onAddToCart={onAddToCart}
        priority={priority}
        showPrice={showPrice}
      />
    );
  }
  return (
    <SpotlightList
      settings={settings}
      products={products}
      editorMode={editorMode}
      showPrice={showPrice}
    />
  );
}

/**
 * `layout: 'stage'` (Phase B2, Souq Showroom): ONE product per screen. A large `object-contain`
 * image on the surface token (a cut-out is never cropped), the name, at most the product's two
 * `onCard` facts as one line, the price through the shared helper with a struck compare-at, and
 * the add control reading `canBuyNow` (a variant product routes to its PDP for options, the
 * card-CTA rule). The compare toggle lives here and on the PLP/compare page only (Ruling B2-6).
 * Sold out shows the shared label and stays linkable. No product for the ref renders NOTHING.
 */
function SpotlightStage({
  settings,
  product,
  editorMode,
  onAddToCart,
  priority,
  showPrice,
}: {
  settings: ProductSpotlightSettings;
  product: TemplateProduct | undefined;
  editorMode: boolean;
  onAddToCart?: (productId: string) => Promise<void>;
  priority: boolean;
  showPrice: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const formatPrice = useLocalePrice();
  const ar = language === 'ar';
  const spacing = sectionSpacingClasses(settings, store.look);
  const [inCompare, setInCompare] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (product) setInCompare(isInCompareList(product.id));
  }, [product]);
  // No product, or a product with no photo: a stage is a photo-led screen, so it renders nothing
  // rather than an empty matte (STOP-2 re-audit). The product still shows in every grid.
  if (!product || !product.images?.[0]?.url) return null;
  const heading =
    (ar ? settings.headingAr || settings.heading : settings.heading || settings.headingAr) || '';
  const name = (ar && product.nameAr ? product.nameAr : product.name) || '';
  const pricing = getProductPricing(product, undefined, 'card');
  const hasVariants = (product.variants?.length ?? 0) > 0;
  const buyable = canBuyNow(product);
  const href = storeUrl(`/products/${product.slug}`);
  const image = product.images?.[0]?.url;
  const edit = (key: string): Record<string, string> | undefined =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : undefined;
  const onCompare = () => {
    const r = toggleCompare({
      id: product.id,
      name: product.name,
      slug: product.slug,
      price: product.price,
      compareAtPrice: product.compareAtPrice ?? undefined,
      images: product.images?.map(i => i.url) ?? [],
      facts: product.facts,
    });
    if (r !== 'max_reached') setInCompare(r === 'added');
  };
  return (
    <section
      data-section="product-spotlight"
      data-layout="stage"
      className={`bg-[hsl(var(--bg-section-alt))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div
        className={`${spacing.innerContainerClass} grid items-center gap-6 md:grid-cols-2 md:gap-10`}
      >
        {/* R-12 / a11y P2-4: the name link below is the stage's one tab stop to this product; the photo
            link repeats it for the pointer only. */}
        <Link
          href={href}
          tabIndex={-1}
          aria-hidden="true"
          data-part="card-image"
          className="relative mx-auto block aspect-square min-h-11 max-h-[min(78svh,680px)] md:max-h-[min(62svh,520px)] w-full overflow-hidden rounded-[var(--radius)] bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {image && (
            <Image
              src={image}
              alt=""
              fill
              sizes="(min-width: 768px) 50vw, 100vw"
              className="object-contain p-6"
              priority={priority}
            />
          )}
        </Link>
        <div className="min-w-0">
          {heading && (
            <p className="text-sm font-medium text-muted-foreground" {...edit('heading')}>
              {heading}
            </p>
          )}
          <h2 className="mt-1 font-display text-[clamp(1.5rem,1.1rem+1.4vw,2.25rem)] leading-tight text-foreground rtl:leading-[1.45]">
            <Link
              href={href}
              className="inline-flex min-h-11 items-center hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {name}
            </Link>
          </h2>
          <FactChips product={product} className="mt-3" />
          <Model3dChip product={product} className="mt-3" />
          {showPrice && (
            <p className="mt-4 flex flex-wrap items-baseline gap-x-3 text-xl font-semibold tabular-nums text-foreground">
              <span>
                {pricing.mode === 'fromMin' ? `${t('From', 'من')} ` : ''}
                {formatPrice(pricing.displayPrice)}
              </span>
              {pricing.displayCompare !== null && (
                <s className="text-base font-normal text-muted-foreground">
                  {formatPrice(pricing.displayCompare)}
                </s>
              )}
            </p>
          )}
          {!buyable && (
            <p className="mt-2 text-sm font-medium text-muted-foreground">{soldOutLabel(ar)}</p>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {buyable && !hasVariants && onAddToCart ? (
              <button
                type="button"
                disabled={adding}
                // a11y P2-1 / 2.5.3: a Showroom home carries up to three stages, so every control
                // names its product and starts with its visible text.
                aria-label={`${t('Add to cart', 'إضافة للسلة')}: ${name}`}
                onClick={async () => {
                  setAdding(true);
                  try {
                    await onAddToCart(product.id);
                  } finally {
                    setAdding(false);
                  }
                }}
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius)] bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('Add to cart', 'إضافة للسلة')}
              </button>
            ) : (
              <Link
                href={href}
                aria-label={`${hasVariants && buyable ? t('Choose options', 'اختيار الخيارات') : t('View', 'عرض')}: ${name}`}
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius)] bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {hasVariants && buyable ? t('Choose options', 'اختيار الخيارات') : t('View', 'عرض')}
              </Link>
            )}
            <button
              type="button"
              aria-pressed={inCompare}
              // One name for both states (the pressed state carries add/remove): a flipping label
              // plus aria-pressed would read as a double toggle.
              aria-label={`${t('Compare', 'قارن')}: ${name}`}
              onClick={onCompare}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius)] border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                inCompare
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input text-foreground hover:border-primary'
              }`}
            >
              {t('Compare', 'قارن')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SpotlightList({
  settings,
  products,
  editorMode = false,
  showPrice = true,
}: {
  settings: ProductSpotlightSettings;
  products: TemplateProduct[];
  editorMode?: boolean;
  showPrice?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const formatPrice = useLocalePrice();
  const ar = language === 'ar';
  const pick = (en?: string, a?: string) => (ar ? a || en : en || a) || '';
  const edit = (key: string): Record<string, string> | undefined =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : undefined;
  const spacing = sectionSpacingClasses(settings, store.look);
  const heading = pick(settings.heading, settings.headingAr);
  const body = pick(settings.body, settings.bodyAr);
  const image = pick(settings.image, settings.imageAr);
  const button = pick(settings.buttonText, settings.buttonTextAr);
  const imageFirst = (settings.imagePosition ?? 'start') === 'start';
  if (!image && products.length === 0) return null;

  return (
    <section
      data-section="product-spotlight"
      className={`bg-[hsl(var(--bg-section-alt))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div
        className={`${spacing.innerContainerClass} grid items-center gap-8 md:grid-cols-12 md:gap-12`}
      >
        {image && (
          <div
            className={`relative aspect-[4/5] overflow-hidden rounded-[var(--radius)] md:col-span-6 ${imageFirst ? 'md:order-1' : 'md:order-2'}`}
          >
            <Image
              src={image}
              alt={pick(settings.alt, settings.altAr)}
              {...imageMarker(editorMode, displayedImageKey(ar, settings.image, settings.imageAr))}
              fill
              sizes="(min-width: 768px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
        )}
        <div
          className={`md:col-span-6 ${image ? (imageFirst ? 'md:order-2' : 'md:order-1') : 'md:col-span-12'}`}
        >
          {heading && (
            <h2
              className="font-display text-balance text-[clamp(1.6rem,1.15rem+1.5vw,2.5rem)] leading-tight text-foreground rtl:leading-[1.45]"
              {...edit('heading')}
            >
              {heading}
            </h2>
          )}
          {body && (
            <p
              className="mt-3 max-w-[48ch] text-pretty text-[15px] leading-relaxed text-muted-foreground"
              {...edit('body')}
            >
              {body}
            </p>
          )}
          {products.length > 0 && (
            <ul className="mt-8 divide-y divide-border border-y border-border">
              {products.map(p => {
                const name = (ar && p.nameAr ? p.nameAr : p.name) || '';
                const pricing = getProductPricing(p, undefined, 'card');
                return (
                  <li key={p.id}>
                    <Link
                      href={storeUrl(`/products/${p.slug}`)}
                      className="group/row flex items-center gap-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="relative aspect-[4/5] w-16 shrink-0 overflow-hidden rounded-[var(--radius)] bg-card">
                        {p.images?.[0]?.url && (
                          <Image
                            src={p.images[0].url}
                            alt=""
                            fill
                            sizes="64px"
                            className="object-cover"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 text-[15px] leading-snug text-foreground transition-colors group-hover/row:text-primary">
                        {name}
                      </span>
                      {showPrice && (
                        <span className="shrink-0 text-[15px] tabular-nums text-primary">
                          {pricing.mode === 'fromMin' ? `${t('From', 'من')} ` : ''}
                          {formatPrice(pricing.displayPrice)}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {button && (
            <Link
              href={storeUrl(sanitizeUrl(settings.buttonLink, '/products'))}
              className="mt-8 inline-flex min-h-[48px] items-center justify-center rounded-[var(--radius)] border border-primary/70 px-7 text-sm font-medium text-primary transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              {...edit('buttonText')}
            >
              {button}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
