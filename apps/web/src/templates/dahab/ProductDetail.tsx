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
 * plus a bar that pins "Add to bag" to the bottom whenever the main button
 * is off-screen in either direction (B0-49). Details / delivery / returns sit in native <details>
 * accordions. `mediaSlot` is the hook for the 3D/AR viewer (PR #35, not
 * merged at the time of writing): whatever is passed renders under the
 * gallery.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import type { ProductOption, ProductVariant } from '@/lib/api';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { VariantSelector } from '../../components/VariantSelector';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import type { ProductFact } from '@ebda/shared';
import { FactsTable } from '../../components/commerce/FactsTable';
import { useAnchorOffscreen } from '../../components/commerce/useAnchorOffscreen';
import { useStickyBarHeight } from '../../components/commerce/useStickyBarHeight';
import { DeliveryChip } from '../../components/commerce/DeliveryChip';
import { TrustLine } from '../../components/commerce/TrustLine';
import type { CodOffer } from '../../lib/cod-offer';
import { PersonalisationField } from '../../components/commerce/PersonalisationField';
import { SizeChartDialog } from '../../components/commerce/SizeChartDialog';
import type { PublicSizeChart } from '@ebda/shared';
import {
  BagIcon,
  CloseIcon,
  DAHAB_BTN_PRIMARY,
  HeartIcon,
  MinusIcon,
  PlusIcon,
  ZoomIcon,
  cx,
} from './ui';
import { ResponsiveImg } from '../../components/ResponsiveImg';

export interface DahabProductDetailProps {
  /** B2B wholesale panel (MOQ + public price breaks + the signed-in buyer's prices), rendered under the price. */
  b2bPanel?: React.ReactNode;
  /** The PDP rating line (a link to #reviews); the page passes it only when the reviews block renders. */
  ratingLine?: React.ReactNode;
  /** The live bundle-saving line (renders nothing without a saving). */
  bundleLine?: React.ReactNode;
  /** Gold-rate line under the price (B5): karat, weight, today's rate. */
  priceNote?: React.ReactNode;
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
  /** B2B minimum order quantity (1 for retail products). */
  minQuantity?: number;
  stockText?: string | null;
  onAddToCart: () => void;
  isAdding: boolean;
  addDisabled: boolean;
  /** DOM id of the note that explains why add is disabled (the gold-rate stale sentence). */
  addDescribedBy?: string;
  addLabel: string;
  isWishlisted: boolean;
  onToggleWishlist: () => void;
  sku?: string | null;
  /** Merchant spec rows, one tap away in an accordion. */
  facts?: ProductFact[];
  /** Made-to-order business days; feeds the delivers-by chip under the buy button. */
  leadTimeDays?: number | null;
  /** Server-read COD offer for the trust line under the buy button (S-02). */
  codOffer?: CodOffer | null;
  /** Raw PersonalisationConfig; the field renders above the buy row only when enabled. */
  personalisation?: unknown;
  /** Resolved size chart (product's, else category's); the size-guide button hides without one. */
  sizeChart?: PublicSizeChart | null;
  note?: string;
  onNoteChange?: (v: string) => void;
  /** Bumped by the page when add-to-cart was tapped with only the required note missing. */
  noteNudge?: number;
  /** Bumped by the page when add-to-cart was tapped with an option still unset (C-02). */
  optionNudge?: number;
  /** Cart link for the pinned bar, which replaces the tab bar while pinned (C-04). */
  cartHref?: string;
  cartCount?: number;
  cartLabel?: string;
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
      <div
        aria-hidden="true"
        className="aspect-[4/5] w-full rounded-[var(--radius)] bg-card max-md:max-h-[52svh]"
      />
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
              className={cx(
                // Phone gallery capped at 52svh (Ruling B0-40): a full-width 4:5 image is
                // ~490px on a 390px phone and pushed the selectors and add-to-cart below the
                // fold. object-cover crops the overflow, as before; desktop is unchanged.
                'relative aspect-[4/5] max-h-[52svh] w-full shrink-0 snap-center bg-card',
                img.id?.startsWith('variant-') && 'variant-image-fade'
              )}
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
            key={current.id?.startsWith('variant-') ? current.id : 'main'}
            src={current.url}
            alt={current.alt || name}
            fill
            sizes="(min-width: 1024px) 50vw, 60vw"
            priority
            className={cx(
              'object-cover transition-transform duration-200 ease-out motion-reduce:transition-none',
              current.id?.startsWith('variant-') && 'variant-image-fade'
            )}
            style={
              zoom
                ? { transform: 'scale(1.9)', transformOrigin: `${zoom.x}% ${zoom.y}%` }
                : undefined
            }
          />
          <span className="absolute bottom-4 end-4 flex h-11 w-11 items-center justify-center rounded-full bg-background text-foreground opacity-0 transition-opacity group-hover/zoom:opacity-100">
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
          className="fixed end-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-background text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                alt={img.alt || name}
                sizes="(max-width: 896px) 100vw, 896px"
                maxWidth={1920}
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
  // Phone buy bar: shown from first paint whenever the main button is off-screen (B0-49).
  const pinBar = useAnchorOffscreen(buyRef);
  const pinBarRef = useRef<HTMLDivElement>(null);
  useStickyBarHeight(pinBarRef, pinBar);

  // Body-level space for the pinned bar (UI rule 6), same flag as StickyAddToCart.
  useEffect(() => {
    if (!pinBar) return;
    document.body.dataset.stickyAtc = '1';
    return () => {
      delete document.body.dataset.stickyAtc;
    };
  }, [pinBar]);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-8" data-zone="products">
      {/* Hidden below md (C-04): on a phone the fold is gallery, title, price, the first
          selector and the buy button; the trail is chrome that pushes them down. */}
      <Breadcrumbs
        className="mb-6 hidden text-[13px] md:block"
        items={[
          { label: t('Home', 'الرئيسية'), href: p.homeHref },
          {
            label: p.categoryName ?? t('All pieces', 'كل القطع'),
            href: p.categoryHref ?? p.productsHref,
          },
          { label: p.name },
        ]}
      />

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
                    className="rounded-[2px] border border-primary/40 px-2 py-1 text-xs leading-none text-primary"
                  >
                    {b}
                  </li>
                ))}
              </ul>
            )}
            <h1
              className="font-display text-balance text-[clamp(1.85rem,1.4rem+1.6vw,2.75rem)] leading-[1.12] text-foreground [overflow-wrap:anywhere] rtl:leading-[1.45]"
              data-zone="productName"
            >
              {p.name}
            </h1>
            {p.ratingLine}
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
            {p.priceNote}
            {p.bundleLine}
            {p.b2bPanel}
            {p.excerpt && (
              <p className="mt-5 text-pretty text-[15px] leading-relaxed text-foreground/80">
                {p.excerpt}
              </p>
            )}

            {p.variants.length > 0 && p.options.length > 0 ? (
              <VariantSelector
                variants={p.variants}
                options={p.options}
                onVariantSelect={p.onVariantSelect}
                onShopperSelect={p.onShopperSelect}
                appearance="swatch"
                sizeGuide={p.sizeChart ? <SizeChartDialog chart={p.sizeChart} /> : undefined}
                nudge={p.optionNudge}
              />
            ) : (
              <SizeChartDialog chart={p.sizeChart} className="mt-4" />
            )}

            {p.onNoteChange && (
              <PersonalisationField
                config={p.personalisation}
                value={p.note ?? ''}
                onChange={p.onNoteChange}
                nudge={p.noteNudge}
                className="mt-8"
              />
            )}

            <div ref={buyRef} className="mt-8 flex items-stretch gap-2 lg:gap-3">
              <div className="flex items-center rounded-[var(--radius)] border border-input">
                <button
                  type="button"
                  onClick={() => p.setQuantity(Math.max(p.minQuantity ?? 1, p.quantity - 1))}
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
                data-testid="pdp-add"
                onClick={p.onAddToCart}
                disabled={p.addDisabled || p.isAdding}
                aria-describedby={p.addDescribedBy}
                className={cx(DAHAB_BTN_PRIMARY, 'min-w-0 flex-1 whitespace-nowrap max-lg:!px-3')}
              >
                {p.isAdding ? t('Adding…', 'بنضيف…') : p.addLabel}
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
                className="flex w-12 items-center justify-center rounded-[var(--radius)] border border-input text-foreground/80 hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HeartIcon className="h-5 w-5" filled={p.isWishlisted} />
              </button>
            </div>
            {/* X-03: a delivery date only for something that can be bought now. */}
            {!p.addDisabled && <DeliveryChip leadTimeDays={p.leadTimeDays} />}
            {/* S-02: COD · return window, from the store's own settings. */}
            <TrustLine cod={p.codOffer ?? null} />
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
              {p.facts && p.facts.length > 0 && (
                <Accordion title={t('Product details', 'تفاصيل المنتج')}>
                  <FactsTable facts={p.facts} className="" />
                </Accordion>
              )}
              {p.specs && <Accordion title={t('Specifications', 'المواصفات')}>{p.specs}</Accordion>}
              <Accordion title={t('Delivery', 'التوصيل')}>
                <p>
                  {t(
                    'Delivery times and fees for your area are shown at checkout.',
                    'مواعيد ومصاريف التوصيل لمنطقتك بتظهر في خطوة إتمام الطلب.'
                  )}{' '}
                  <Link href={p.shippingHref} className="text-primary underline underline-offset-4">
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
                  <Link href={p.returnsHref} className="text-primary underline underline-offset-4">
                    {t('Returns policy', 'سياسة الاسترجاع')}
                  </Link>
                </p>
              </Accordion>
            </div>
            {p.extras && <div className="mt-6 space-y-5">{p.extras}</div>}
          </div>
        </div>
      </div>

      {/* Phones: pinned buy bar whenever the main button is off-screen, either direction (B0-49). */}
      <div
        ref={pinBarRef}
        aria-hidden={!pinBar}
        inert={!pinBar ? true : undefined}
        className={cx(
          // Solid ground, no glass (taste bar bans glassmorphism); ease-out-quint like the
          // default path's .sticky-bar-in (F10).
          // C-04: it REPLACES the tab bar while pinned (useStickyBarHeight marks
          // <html data-task-bar>), so it sits at the bottom edge, safe-area inside.
          'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none md:hidden',
          pinBar ? 'translate-y-0' : 'translate-y-full'
        )}
      >
        <div className="flex items-center gap-3">
          {p.cartHref && (
            <Link
              href={p.cartHref}
              aria-label={p.cartLabel}
              data-testid="dahab-pinned-cart"
              className="relative inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius)] border border-input text-foreground"
            >
              <BagIcon className="h-[22px] w-[22px]" aria-hidden="true" />
              {(p.cartCount ?? 0) > 0 && (
                <span className="absolute -end-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold leading-none text-primary-foreground tabular-nums">
                  {localize(p.cartCount ?? 0)}
                </span>
              )}
            </Link>
          )}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-1 text-[13px] text-foreground/80 [overflow-wrap:anywhere]">
              {p.name}
            </p>
            <p className="text-[15px] tabular-nums text-primary">{p.priceText}</p>
          </div>
          <button
            type="button"
            data-testid="dahab-pinned-add"
            onClick={p.onAddToCart}
            disabled={p.addDisabled || p.isAdding}
            aria-describedby={p.addDescribedBy}
            className={cx(DAHAB_BTN_PRIMARY, 'px-6')}
          >
            {p.isAdding ? t('Adding…', 'بنضيف…') : p.addLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
