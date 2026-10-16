'use client';

/**
 * "Shop this look" page body (W2a; amends Ruling B1-6): the look photo, then its pieces side by
 * side. Every piece is a small buy block (not a product card: no card chrome, no card CTA system):
 * photo + name (a link to its PDP), price through the shared pricing helpers (`toTemplateProduct`,
 * `getProductPricing` 'detail', `useLocalePrice`, `soldOutLabel`, the store's OOS label text),
 * the shared `VariantSelector` for its size, and its own add. A piece is added only with a full
 * selection (the cart API refuses a variant parent without one); a tap without it says which
 * choice is missing. A piece with a required personalisation note opens its PDP instead.
 */
import React, { useCallback, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { Product, ProductVariant } from '@/lib/api';
import { useStore, useStoreUrl } from '../../../../contexts/StoreContext';
import { useLanguage } from '../../../../contexts/LanguageContext';
import { useCart } from '../../../../contexts/CartContext';
import { useLocalePrice } from '../../../../hooks/useLocalePrice';
import { ShopChrome } from '../../../../components';
import { VariantSelector } from '../../../../components/VariantSelector';
import { Breadcrumbs } from '../../../../components/Breadcrumbs';
import { canBuyNow } from '../../../../lib/can-buy-now';
import { toTemplateProduct } from '../../../../templates/adapters';
import { getProductPricing } from '../../../../lib/product-pricing';
import { soldOutLabel } from '../../../../templates/shared/ProductCardCta';
import { resolveProductCardCtaOosDefaults } from '../../../../templates/shared/product-card-defaults';
import type { LookPanel } from '../../../../lib/shop-the-look';
import { sectionBgStyle } from '../../../../templates/shared/section-bg';
import { INVERSE_SURFACE, pickReadableForeground } from '@ebda/shared';

export function LookPiecesClient({ panel, pieces }: { panel: LookPanel; pieces: Product[] }) {
  const { language, t } = useLanguage();
  const { store, layout } = useStore();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const title = (ar ? panel.titleAr || panel.title : panel.title || panel.titleAr).trim();
  const image = (ar ? panel.imageAr || panel.image : panel.image || panel.imageAr).trim();
  const alt = (ar ? panel.altAr || panel.alt : panel.alt || panel.altAr).trim() || title;
  const oos = resolveProductCardCtaOosDefaults(layout);
  // On a dark page (Lookbook) the white-ground product photos sit on the inverse band, as the
  // look's own new-in grid does (LB-01); a light page keeps its surface.
  const darkPage =
    !!store?.theme?.backgroundColor &&
    pickReadableForeground(`hsl(${store.theme.backgroundColor})`) === '#ffffff';
  const piecesBand = darkPage ? sectionBgStyle(INVERSE_SURFACE, store.theme) : undefined;
  const cols = pieces.length >= 4 ? 'lg:grid-cols-4' : pieces.length === 3 ? 'lg:grid-cols-3' : '';

  return (
    <ShopChrome>
      <div className="mx-auto max-w-7xl px-4 pb-10 pt-6 sm:px-6 lg:px-8" data-page="look-panel">
        {/* The ONE storefront trail (R-06): home, then this look. */}
        <Breadcrumbs
          className="text-sm"
          items={[
            { label: t('Home', 'الرئيسية'), href: storeUrl('/') },
            { label: title || t('Shop this look', 'تسوّق هذا اللوك') },
          ]}
        />
        <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-end">
          {image && (
            <div className="relative aspect-[4/5] w-full max-w-sm overflow-hidden rounded-[var(--radius)] bg-muted">
              <Image
                src={image}
                alt={alt}
                fill
                priority
                sizes="(min-width: 768px) 384px, 100vw"
                className="object-cover"
              />
            </div>
          )}
          <div>
            <h1 className="font-display text-balance text-3xl leading-snug text-foreground sm:text-4xl">
              {title || t('Shop this look', 'تسوّق هذا اللوك')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                'Choose a size for each piece and add the ones you want.',
                'اختيار المقاس لكل قطعة وإضافة القطع المطلوبة.'
              )}
            </p>
          </div>
        </div>
      </div>
      <div style={piecesBand} data-band={darkPage ? 'inverse' : undefined}>
        <div className="mx-auto max-w-7xl px-4 pb-16 pt-10 sm:px-6 lg:px-8">
          <ul
            aria-label={t('Items in this look', 'قطع اللوك')}
            className={`grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 ${cols}`}
          >
            {pieces.map(p => (
              <li key={p.id}>
                <LookPiece product={p} oos={oos} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </ShopChrome>
  );
}

function LookPiece({
  product,
  oos,
}: {
  product: Product;
  oos: ReturnType<typeof resolveProductCardCtaOosDefaults>;
}) {
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const { addItem } = useCart();
  const formatPrice = useLocalePrice();
  const ar = language === 'ar';
  const [variant, setVariant] = useState<ProductVariant | null>(null);
  const [missing, setMissing] = useState(false);
  const [adding, setAdding] = useState(false);
  const onVariant = useCallback((v: ProductVariant | null) => {
    setVariant(v);
    if (v) setMissing(false);
  }, []);

  const tp = toTemplateProduct(product);
  const name = (ar && product.nameAr ? product.nameAr : product.name) || '';
  const hasVariants = (product.variants?.length ?? 0) > 0 && (product.options?.length ?? 0) > 0;
  const pricing = getProductPricing(tp, variant ?? undefined, 'detail');
  // The ONE stock rule (X-02): stock or backorder, the variant deciding once one is picked.
  const orderable = canBuyNow(product, variant);
  const needsNote = product.personalisation?.enabled === true && product.personalisation.required;
  const href = storeUrl(`/products/${product.slug}`);
  const thumb = product.images?.[0]?.url;
  const from = t('From', 'من');

  const add = async () => {
    if (hasVariants && !variant) {
      setMissing(true);
      return;
    }
    setAdding(true);
    await addItem({
      id: product.id,
      name: product.name,
      nameAr: product.nameAr ?? undefined,
      price: variant ? variant.price : product.price,
      slug: product.slug,
      image: thumb,
      category: product.categories?.[0]?.category?.name,
      variantId: variant?.id,
    });
    setAdding(false);
  };

  return (
    <article className="flex h-full flex-col" data-part="look-piece">
      <Link
        href={href}
        className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative block aspect-[3/4] overflow-hidden rounded-[var(--radius)] bg-muted">
          {thumb && (
            <Image
              src={thumb}
              alt=""
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
              className={`object-cover ${orderable ? '' : 'opacity-60'}`}
            />
          )}
        </span>
        <h2 className="mt-3 text-base leading-snug text-foreground group-hover:underline underline-offset-4">
          {name}
        </h2>
      </Link>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium tabular-nums text-foreground">
          {`${!variant && pricing.mode === 'fromMin' ? `${from} ` : ''}${formatPrice(pricing.displayPrice)}`}
        </span>
        {pricing.displayCompare && (
          <span className="tabular-nums text-muted-foreground line-through">
            {formatPrice(pricing.displayCompare)}
          </span>
        )}
      </p>
      {!orderable && oos.resolvedOosLabel !== false && (
        <p className="mt-1 text-sm text-muted-foreground">
          {soldOutLabel(ar, oos.resolvedOosLabelTextEn, oos.resolvedOosLabelTextAr)}
        </p>
      )}
      {hasVariants && !needsNote && (
        <div className="mt-3" data-part="piece-options">
          <VariantSelector
            variants={product.variants ?? []}
            options={product.options ?? []}
            onVariantSelect={onVariant}
          />
        </div>
      )}
      <div className="mt-auto pt-4">
        {needsNote ? (
          <Link
            href={href}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-[var(--radius)] border border-input px-4 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t('Personalise on the product page', 'التخصيص من صفحة المنتج')}
          </Link>
        ) : (
          <>
            <button
              type="button"
              onClick={add}
              disabled={!orderable || adding}
              aria-describedby={missing ? `missing-${product.id}` : undefined}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:bg-primary/90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {orderable
                ? t('Add to Cart', 'أضف إلى السلة')
                : soldOutLabel(ar, oos.resolvedOosLabelTextEn, oos.resolvedOosLabelTextAr)}
            </button>
            <p
              id={`missing-${product.id}`}
              role="status"
              aria-live="polite"
              className="mt-2 min-h-[1.25rem] text-sm text-foreground"
            >
              {missing ? t('Choose the options above first', 'اختيار الخيارات أولًا') : ''}
            </p>
          </>
        )}
      </div>
    </article>
  );
}
