'use client';

/**
 * Dahab product page (presentation only). `ProductDetailClient` keeps every
 * piece of commerce logic — product fetch, variant resolution, pricing,
 * stock and backorder rules, add-to-cart, pixels, wishlist — and hands this
 * component the results, so the Dahab page cannot drift from the platform's
 * rules; it only decides how they look.
 *
 * Desktop: gallery (7 cols, hover-zoom, click for full screen) beside a
 * sticky buying column (5 cols). Phones: a swipe gallery, then the column,
 * plus a bar that pins "Add to bag" to the bottom once the main button
 * scrolls away. Details / delivery / returns sit in native <details>
 * accordions. `mediaSlot` is the hook for the 3D/AR viewer (PR #35, not
 * merged at the time of writing): whatever is passed renders under the
 * gallery.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { ProductOption, ProductVariant } from '@/lib/api';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { VariantSelector } from '../../components/VariantSelector';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import {
  CloseIcon,
  DAHAB_BTN_PRIMARY,
  HeartIcon,
  MinusIcon,
  PlusIcon,
  ZoomIcon,
  ChevronIcon,
  cx,
} from './ui';
import { ResponsiveImg } from '../../components/ResponsiveImg';

export interface DahabProductDetailProps {
  images: Array<{ id?: string; url: string; alt?: string | null }>;
  name: string;
  categoryName?: string;
  categoryHref?: string;
  homeHref: string;
  productsHref: string;
  shippingHref: string;
  returnsHref: string;
  excerpt?: string | null;
  description?: string | null;
  priceText: string;
  compareText?: string | null;
  badges: string[];
  variants: ProductVariant[];
  options: ProductOption[];
  onVariantSelect: (v: ProductVariant | null) => void;
  onShopperSelect: () => void;
  quantity: number;
  setQuantity: (q: number) => void;
  maxQuantity: number;
  stockText?: string | null;
  onAddToCart: () => void;
  isAdding: boolean;
  addDisabled: boolean;
  addLabel: string;
  isWishlisted: boolean;
  onToggleWishlist: () => void;
  sku?: string | null;
  /** Spec table, WhatsApp order button, share row — platform components. */
  specs?: ReactNode;
  extras?: ReactNode;
  /** 3D / AR viewer slot (PR #35). */
  mediaSlot?: ReactNode;
  selectedImage: number;
  onSelectImage: (i: number) => void;
}

function Gallery({
  images,
  name,
  selected,
  onSelect,
}: {
  images: DahabProductDetailProps['images'];
  name: string;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const { t } = useLanguage();
  const track = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  // Keep the phone track in step with an external pick (thumbnail / variant image).
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const target = el.clientWidth * selected;
    if (Math.abs(el.scrollLeft - target) > 8) el.scrollTo({ left: target, behavior: 'smooth' });
  }, [selected]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (lightbox && !d.open) d.showModal();
    if (!lightbox && d.open) d.close();
  }, [lightbox]);

  if (images.length === 0)
    return (
      <div aria-hidden="true" className="aspect-[4/5] w-full rounded-[var(--radius)] bg-card" />
    );
  const current = images[Math.min(selected, images.length - 1)];

  return (
    <div>
      {/* Phones: swipe track (dir=ltr keeps scrollLeft positive in every browser). */}
      <div className="md:hidden">
        <div
          ref={track}
          dir="ltr"
          onScroll={e => {
            const el = e.currentTarget;
            const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
            if (i !== selected) onSelect(i);
          }}
          className="-mx-4 flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {images.map((img, i) => (
            <button
              key={img.id ?? i}
              type="button"
              onClick={() => setLightbox(true)}
              className="relative aspect-[4/5] w-full shrink-0 snap-center bg-card"
              aria-label={t(`Open image ${i + 1} full screen`, `فتح الصورة ${i + 1} بملء الشاشة`)}
            >
              <Image
                src={img.url}
                alt={img.alt || name}
                fill
                sizes="100vw"
                priority={i === 0}
                className="object-cover"
              />
            </button>
          ))}
        </div>
        {images.length > 1 && (
          <div className="mt-4 flex justify-center gap-2" aria-hidden="true">
            {images.map((_, i) => (
              <span
                key={i}
                className={cx(
                  'h-px w-6 transition-colors',
                  i === selected ? 'bg-primary' : 'bg-foreground/25'
                )}
              />
            ))}
          </div>
        )}
      </div>

      {/* Desktop: main image with hover zoom + thumbnails at the inline start. */}
      <div className="hidden gap-4 md:flex">
        {images.length > 1 && (
          <ul
            className="flex w-20 shrink-0 flex-col gap-3"
            aria-label={t('Product images', 'صور المنتج')}
          >
            {images.map((img, i) => (
              <li key={img.id ?? i}>
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  aria-current={i === selected}
                  aria-label={t(`Show image ${i + 1}`, `عرض الصورة ${i + 1}`)}
                  className={cx(
                    'relative block aspect-[4/5] w-full overflow-hidden rounded-[var(--radius)] bg-card ring-1 transition',
                    i === selected
                      ? 'ring-primary'
                      : 'ring-transparent opacity-70 hover:opacity-100'
                  )}
                >
                  <Image src={img.url} alt="" fill sizes="80px" className="object-cover" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => setLightbox(true)}
          onMouseMove={e => {
            const r = e.currentTarget.getBoundingClientRect();
            setZoom({
              x: ((e.clientX - r.left) / r.width) * 100,
              y: ((e.clientY - r.top) / r.height) * 100,
            });
          }}
          onMouseLeave={() => setZoom(null)}
          className="group/zoom relative aspect-[4/5] flex-1 cursor-zoom-in overflow-hidden rounded-[var(--radius)] bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('Open full screen', 'فتح بملء الشاشة')}
        >
          <Image
            src={current.url}
            alt={current.alt || name}
            fill
            sizes="(min-width: 1024px) 50vw, 60vw"
            priority
            className="object-cover transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={
              zoom
                ? { transform: 'scale(1.9)', transformOrigin: `${zoom.x}% ${zoom.y}%` }
                : undefined
            }
          />
          <span className="absolute bottom-4 end-4 flex h-10 w-10 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover/zoom:opacity-100">
            <ZoomIcon className="h-5 w-5" />
          </span>
        </button>
      </div>

      <dialog
        ref={dialog}
        onClose={() => setLightbox(false)}
        onClick={e => {
          if (e.target === e.currentTarget) setLightbox(false);
        }}
        aria-label={name}
        className="m-0 h-[100dvh] max-h-none w-screen max-w-none bg-background p-0 text-foreground backdrop:bg-background"
      >
        <button
          type="button"
          onClick={() => setLightbox(false)}
          className="fixed end-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-background/80 text-foreground backdrop-blur-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('Close', 'إغلاق')}
        >
          <CloseIcon className="h-5 w-5" />
        </button>
        {lightbox && (
          <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pt-16">
            {images.map((img, i) => (
              <ResponsiveImg
                key={img.id ?? i}
                src={img.url}
                sizes="(min-width: 896px) 896px, 100vw"
                alt={img.alt || name}
                loading={i === selected ? 'eager' : 'lazy'}
                className="w-full rounded-[var(--radius)]"
              />
            ))}
          </div>
        )}
      </dialog>
    </div>
  );
}

function Accordion({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open} className="group/acc border-b border-border">
      <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-4 text-[15px] text-foreground marker:hidden hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {title}
        <span aria-hidden="true" className="relative h-4 w-4 shrink-0 text-primary">
          <MinusIcon className="absolute inset-0 h-4 w-4" />
          <MinusIcon className="absolute inset-0 h-4 w-4 rotate-90 transition-transform duration-300 group-open/acc:rotate-0" />
        </span>
      </summary>
      <div className="pb-6 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

export function DahabProductDetail(p: DahabProductDetailProps) {
  const { t } = useLanguage();
  const { localize } = useNumerals();
  const buyRef = useRef<HTMLDivElement>(null);
  const [pinBar, setPinBar] = useState(false);

  // Pin the phone buy bar once the main button has scrolled above the viewport.
  useEffect(() => {
    const el = buyRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setPinBar(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      { threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-8" data-zone="products">
      <nav
        aria-label={t('Breadcrumb', 'مسار التصفح')}
        className="mb-6 text-[13px] text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link href={p.homeHref} className="hover:text-primary">
              {t('Home', 'الرئيسية')}
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronIcon className="h-3 w-3" />
          </li>
          <li>
            <Link href={p.categoryHref ?? p.productsHref} className="hover:text-primary">
              {p.categoryName ?? t('All pieces', 'كل القطع')}
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronIcon className="h-3 w-3" />
          </li>
          <li aria-current="page" className="line-clamp-1 text-foreground/80">
            {p.name}
          </li>
        </ol>
      </nav>

      <div className="grid gap-8 md:grid-cols-12 md:gap-10 lg:gap-16">
        <div className="md:col-span-7">
          <Gallery
            images={p.images}
            name={p.name}
            selected={p.selectedImage}
            onSelect={p.onSelectImage}
          />
          {p.mediaSlot}
        </div>

        <div className="md:col-span-5">
          <div className="md:sticky md:top-28">
            {p.badges.length > 0 && (
              <ul className="mb-4 flex flex-wrap gap-2">
                {p.badges.map(b => (
                  <li
                    key={b}
                    className="rounded-[2px] border border-primary/40 px-2 py-1 text-[11px] leading-none text-primary"
                  >
                    {b}
                  </li>
                ))}
              </ul>
            )}
            <h1
              className="font-display text-balance text-[clamp(1.85rem,1.4rem+1.6vw,2.75rem)] leading-[1.12] text-foreground rtl:leading-[1.45]"
              data-zone="productName"
            >
              {p.name}
            </h1>
            <div
              className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1"
              data-zone="productPrice"
            >
              <span className="text-2xl tabular-nums text-primary">{p.priceText}</span>
              {p.compareText && (
                <span className="text-base tabular-nums text-muted-foreground line-through">
                  <span className="sr-only">{t('Was', 'كان')} </span>
                  {p.compareText}
                </span>
              )}
            </div>
            <TaxInclusiveLabel className="mt-1 block text-xs text-muted-foreground" />
            {p.excerpt && (
              <p className="mt-5 text-pretty text-[15px] leading-relaxed text-foreground/80">
                {p.excerpt}
              </p>
            )}

            {p.variants.length > 0 && p.options.length > 0 && (
              <VariantSelector
                variants={p.variants}
                options={p.options}
                onVariantSelect={p.onVariantSelect}
                onShopperSelect={p.onShopperSelect}
                appearance="swatch"
              />
            )}

            <div ref={buyRef} className="mt-8 flex items-stretch gap-3">
              <div className="flex items-center rounded-[var(--radius)] border border-border">
                <button
                  type="button"
                  onClick={() => p.setQuantity(Math.max(1, p.quantity - 1))}
                  aria-label={t('Decrease quantity', 'تقليل الكمية')}
                  className="flex h-12 w-11 items-center justify-center text-foreground/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MinusIcon className="h-4 w-4" />
                </button>
                <span aria-live="polite" className="w-8 text-center tabular-nums">
                  {localize(p.quantity)}
                </span>
                <button
                  type="button"
                  onClick={() => p.setQuantity(Math.min(p.maxQuantity, p.quantity + 1))}
                  aria-label={t('Increase quantity', 'زيادة الكمية')}
                  className="flex h-12 w-11 items-center justify-center text-foreground/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PlusIcon className="h-4 w-4" />
                </button>
              </div>
              <button
                type="button"
                onClick={p.onAddToCart}
                disabled={p.addDisabled || p.isAdding}
                className={cx(DAHAB_BTN_PRIMARY, 'flex-1')}
              >
                {p.isAdding ? t('Adding…', 'جاري الإضافة…') : p.addLabel}
              </button>
              <button
                type="button"
                onClick={p.onToggleWishlist}
                aria-pressed={p.isWishlisted}
                aria-label={
                  p.isWishlisted
                    ? t('Remove from wishlist', 'إزالة من المفضلة')
                    : t('Add to wishlist', 'إضافة للمفضلة')
                }
                className="flex w-12 items-center justify-center rounded-[var(--radius)] border border-border text-foreground/80 hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HeartIcon className="h-5 w-5" filled={p.isWishlisted} />
              </button>
            </div>
            {p.stockText && <p className="mt-3 text-[13px] text-muted-foreground">{p.stockText}</p>}

            <div className="mt-8 border-t border-border">
              {p.description && (
                <Accordion title={t('Details', 'التفاصيل')} open>
                  <p className="whitespace-pre-line">{p.description}</p>
                  {p.sku && (
                    <p className="mt-3 text-xs">
                      {t('Item code', 'كود القطعة')}: <span dir="ltr">{p.sku}</span>
                    </p>
                  )}
                </Accordion>
              )}
              {p.specs && <Accordion title={t('Specifications', 'المواصفات')}>{p.specs}</Accordion>}
              <Accordion title={t('Delivery', 'التوصيل')}>
                <p>
                  {t(
                    'Delivery times and fees for your area are shown at checkout.',
                    'مواعيد ومصاريف التوصيل لمنطقتك بتظهر في خطوة إتمام الطلب.'
                  )}{' '}
                  <Link
                    href={p.shippingHref}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {t('Delivery policy', 'سياسة التوصيل')}
                  </Link>
                </p>
              </Accordion>
              <Accordion title={t('Returns and exchange', 'الاسترجاع والاستبدال')}>
                <p>
                  {t(
                    'Read how returns and exchanges work for this store.',
                    'اعرف إزاي الاسترجاع والاستبدال في المتجر ده.'
                  )}{' '}
                  <Link
                    href={p.returnsHref}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {t('Returns policy', 'سياسة الاسترجاع')}
                  </Link>
                </p>
              </Accordion>
            </div>
            {p.extras && <div className="mt-6 space-y-5">{p.extras}</div>}
          </div>
        </div>
      </div>

      {/* Phones: pinned buy bar once the main button is out of view. */}
      <div
        aria-hidden={!pinBar}
        inert={!pinBar ? true : undefined}
        className={cx(
          'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur-md transition-transform duration-300 motion-reduce:transition-none md:hidden',
          pinBar ? 'translate-y-0' : 'translate-y-full'
        )}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-1 text-[13px] text-foreground/80">{p.name}</p>
            <p className="text-[15px] tabular-nums text-primary">{p.priceText}</p>
          </div>
          <button
            type="button"
            onClick={p.onAddToCart}
            disabled={p.addDisabled || p.isAdding}
            className={cx(DAHAB_BTN_PRIMARY, 'px-6')}
          >
            {p.isAdding ? t('Adding…', 'جاري الإضافة…') : p.addLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
