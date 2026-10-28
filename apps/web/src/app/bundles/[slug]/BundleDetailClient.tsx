'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from '../../../components/StoreLink';
import Image from 'next/image';
import { Button, Badge } from '@ebda/ui';
import { api, type PublicBundleDetail } from '@/lib/api';
import { useLocalePrice } from '../../../hooks/useLocalePrice';
import { useCart } from '../../../contexts/CartContext';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage, translations } from '../../../contexts/LanguageContext';
import { useNumerals } from '../../../hooks/useNumerals';
import { ShopChrome } from '../../../components';
import { trackAddToCart } from '../../../components/MarketingPixels';
import { OosImageDim, OutOfStockRibbon } from '../../../templates/shared/ProductCardCta';
import {
  pickBundleName,
  pickBundleDescription,
  pickBundleComponentNames,
} from '@/lib/bundle-locale';

import { fromMinor, REGION } from '@ebda/shared';
import { Breadcrumbs } from '../../../components/Breadcrumbs';
import { MinusIcon, PlusIcon } from '../../../templates/shared/icons';
function BundleSkeleton() {
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

interface BundleDetailClientProps {
  initialBundle?: PublicBundleDetail | null;
}

export default function BundleDetailClient({ initialBundle }: BundleDetailClientProps) {
  const params = useParams();
  const slug = params?.slug as string;

  const [bundle, setBundle] = useState<PublicBundleDetail | null>(initialBundle ?? null);
  const bundleRef = useRef(bundle);
  const initialSlug = initialBundle?.slug;
  bundleRef.current = bundle;
  const [isLoading, setIsLoading] = useState(!initialBundle);
  const [notFound, setNotFound] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [isAdding, setIsAdding] = useState(false);

  const { addBundle } = useCart();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  const formatPrice = useLocalePrice();

  // Mirrors ProductDetailClient's own client-side re-fetch: `initialBundle`
  // covers the first (server) render, this covers client-side navigation
  // between bundle slugs without a full page reload.
  //
  // (#1556) The server already rendered `initialBundle` for this slug, so the
  // first mount does NOT re-fetch — re-fetching tore the SSR'd page (and its
  // LCP image) down to a skeleton on every view, like ProductDetailClient's
  // own initial-data guard avoids. And only an explicit unsuccessful answer
  // means "not found": a network error keeps whatever bundle is on screen.
  useEffect(() => {
    if (!store?.id || store.id === 'demo' || !slug) return;
    if (initialSlug === slug) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setNotFound(false);
      try {
        const res = await api.getPublicBundle(store.id, slug);
        if (cancelled) return;
        if (res.success && res.data?.bundle) {
          setBundle(res.data.bundle);
        } else {
          setBundle(null);
          setNotFound(true);
        }
      } catch {
        // Transient failure: keep the bundle on screen when it IS this slug;
        // only with nothing valid to show is the not-found body honest.
        if (!cancelled) {
          const keep = bundleRef.current?.slug === slug;
          if (!keep) {
            setBundle(null);
            setNotFound(true);
          }
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, store?.id, initialSlug]);

  if (isLoading) {
    return (
      <ShopChrome>
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 flex-1">
          <BundleSkeleton />
        </div>
      </ShopChrome>
    );
  }

  if (notFound || !bundle) {
    return (
      <ShopChrome>
        <div className="mx-auto max-w-7xl px-4 py-16 text-center flex-1">
          <h1 className="text-2xl font-bold text-foreground">
            {t('Bundle not found', 'الباقة غير موجودة')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              "The bundle you're looking for may have been removed or doesn't exist.",
              'الباقة اللي بتدوّر عليها ممكن تكون اتشالت أو مش موجودة.'
            )}
          </p>
          <Link href={storeUrl('/products')}>
            <Button className="mt-6">{t('Browse Products', 'تصفح المنتجات')}</Button>
          </Link>
        </div>
      </ShopChrome>
    );
  }

  const displayName = pickBundleName(bundle, language);
  const displayDescription = pickBundleDescription(bundle, language);
  const componentNames = pickBundleComponentNames(bundle, language);
  const savings = bundle.componentSum - bundle.price;
  const isPurchasable = bundle.isPurchasable;

  const handleAddToCart = async () => {
    setIsAdding(true);
    const added = await addBundle(bundle.id, quantity);
    setIsAdding(false);
    if (!added) return;
    trackAddToCart({
      contentId: bundle.id,
      contentName: bundle.name,
      quantity,
      value: fromMinor(bundle.price),
      currency: REGION.currency,
    });
  };

  return (
    <ShopChrome>
      <div className="flex-1">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8" data-zone="products">
          {/* Breadcrumb — Home / Bundles / <name>, now that the `/bundles`
              index page exists (mirrors ProductDetailClient's
              Home/Products/category chain). */}
          <Breadcrumbs
            className="mb-8 text-sm"
            items={[
              { label: t('Home', translations['Home']), href: storeUrl('/') },
              { label: t('Bundles', 'الباقات'), href: storeUrl('/bundles') },
              { label: displayName },
            ]}
          />

          <div className="grid gap-8 md:grid-cols-12">
            {/* Image */}
            <div className="space-y-4 md:col-span-5">
              <div className="relative aspect-[3/4] mx-auto max-w-[280px] sm:max-w-[400px] lg:max-w-[600px] overflow-hidden rounded-2xl bg-gradient-to-br from-primary/5 to-primary/10">
                {bundle.image ? (
                  <Image
                    src={bundle.image}
                    alt={displayName}
                    width={600}
                    height={800}
                    className="h-full w-full object-cover"
                    sizes="(max-width: 768px) 100vw, (max-width: 1024px) 40vw, 32vw"
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
                <OosImageDim orderable={isPurchasable} theme={store?.theme} />
                <OutOfStockRibbon
                  inStock={isPurchasable}
                  isRtl={language === 'ar'}
                  oosLabelTextEn="Unavailable"
                  oosLabelTextAr="غير متاح"
                  theme={store?.theme}
                />
              </div>
            </div>

            {/* Info */}
            <div className="md:col-span-7">
              <div className="mb-4 flex items-center gap-2">
                <Badge variant="secondary">{t('Bundle', 'باقة')}</Badge>
                {isPurchasable && savings > 0 && (
                  <Badge variant="destructive">
                    {t('Save', 'وفّر')} {formatPrice(savings)}
                  </Badge>
                )}
              </div>

              <h1 className="text-3xl font-bold text-foreground">{displayName}</h1>

              <div className="mt-4 flex items-baseline gap-3">
                <span className="text-2xl font-bold text-primary">{formatPrice(bundle.price)}</span>
                {savings > 0 && (
                  <span className="text-lg text-muted-foreground line-through">
                    {formatPrice(bundle.componentSum)}
                  </span>
                )}
              </div>

              {displayDescription && (
                <p className="mt-6 max-w-prose whitespace-pre-line text-muted-foreground leading-relaxed">
                  {displayDescription}
                </p>
              )}

              {/* What's in the box — component NAMES only, never a
                  per-component price (see PublicBundleDetail's doc
                  comment). */}
              {componentNames.length > 0 && (
                <div className="mt-6 border-t border-border pt-6">
                  <h2 className="text-sm font-semibold text-foreground">
                    {t("What's included", 'محتويات الباقة')}
                  </h2>
                  <ul className="mt-3 space-y-1.5">
                    {componentNames.map((name, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <svg
                          className="h-4 w-4 shrink-0 text-primary"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        <span>{name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Quantity & Add to Cart */}
              <div className="mt-8 space-y-4">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-foreground">
                    {t('Quantity', 'الكمية')}:
                  </span>
                  <div className="flex items-center rounded-lg border border-input">
                    <button
                      type="button"
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                      aria-label={t('Decrease quantity', 'تقليل الكمية')}
                      disabled={!isPurchasable}
                      className="flex h-11 min-w-11 items-center justify-center px-4 text-muted-foreground hover:bg-muted cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <MinusIcon />
                    </button>
                    <span aria-live="polite" className="w-12 text-center font-medium">
                      {localize(quantity)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const maxQty = bundle.available > 0 ? Math.min(bundle.available, 10) : 10;
                        setQuantity(q => Math.min(q + 1, maxQty));
                      }}
                      aria-label={t('Increase quantity', 'زيادة الكمية')}
                      disabled={!isPurchasable}
                      className="flex h-11 min-w-11 items-center justify-center px-4 text-muted-foreground hover:bg-muted cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <PlusIcon />
                    </button>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {isPurchasable ? t('In Stock', 'متوفر') : t('Unavailable', 'غير متاح')}
                  </span>
                </div>

                <Button
                  size="lg"
                  className="w-full"
                  onClick={handleAddToCart}
                  isLoading={isAdding}
                  disabled={!isPurchasable}
                >
                  {isPurchasable
                    ? t('Add to Cart', translations['Add to Cart'])
                    : t('Unavailable', 'غير متاح')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ShopChrome>
  );
}
