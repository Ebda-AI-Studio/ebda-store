'use client';

/**
 * `shop-the-look` (Phase B1, the Qamar Lookbook look; Ruling B1-2, document-only): a native
 * scroll-snap row of looks. Each `look` block is one photo, a name and up to 4 pieces.
 *
 * The piece rows are a PRODUCT RENDER PATH (C19, CLAUDE.md card paths): name, price, compare-at
 * and sold-out come through the same helpers as the cards (`toTemplateProduct`,
 * `getProductPricing`, `useLocalePrice`, `soldOutLabel`, the store's card-price switch). A row is
 * a link to the PDP and nothing else: no quick add, no "add the whole look" (Ruling B1-6). Each
 * panel ends in one "Shop this look" link to `/looks/<section>/<look>`, the page that lists only
 * that panel's pieces side by side with a size choice and an add each (W2a, amends B1-6).
 *
 * Products resolve against the store's own pool (the homepage fetch is store-scoped), so an
 * unknown or another store's id is simply absent and never renders (C11). A look with no piece
 * found is skipped; a section with no look returns null (a dashed hint in the editor canvas).
 */
import React, { useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type {
  BlockNode,
  SectionPaddingMaxWidthVisibility,
  StoreLayoutSettings,
} from '@ebda/shared';
import type { Product } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { ScrollArrows } from '../../templates/shared/ScrollArrows';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { toTemplateProduct } from '../../templates/adapters';
import { getProductPricing } from '../../lib/product-pricing';
import { canBuyNow } from '../../lib/can-buy-now';
import { soldOutLabel } from '../../templates/shared/ProductCardCta';
import { resolveProductCardCtaOosDefaults } from '../../templates/shared/product-card-defaults';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { EmptySectionHint } from '../render/EmptySectionHint';
import { SectionHeader } from './SectionHeader';
import { lookPanelPath } from '../../lib/shop-the-look';

export interface ShopTheLookSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  bgColor?: string;
}

/** Panel widths: most of a phone, two on a tablet, three on a desktop (the row fills or centres). */
const PANEL = 'w-[85%] shrink-0 snap-start sm:w-[45%] lg:w-[32%]';

export function ShopTheLookSection({
  sectionId,
  settings,
  blocks,
  products,
  editorMode = false,
  showPrice = true,
  cardLayout,
}: {
  /** The section's node id; with the block id it addresses the panel's own page. */
  sectionId?: string;
  settings: ShopTheLookSettings;
  blocks: BlockNode[];
  /** The store's own product pool (store-scoped fetch). */
  products: Product[];
  editorMode?: boolean;
  /** The store's effective card-price switch (`showPriceOnCards` x `showCardPrice`). */
  showPrice?: boolean;
  /** Card defaults (the merchant's OOS label text), as every card path reads them. */
  cardLayout?: StoreLayoutSettings | null;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const rowRef = useRef<HTMLUListElement>(null);
  const storeUrl = useStoreUrl();
  const formatPrice = useLocalePrice();
  const ar = language === 'ar';
  const pick = (en?: unknown, a?: unknown) =>
    ((ar ? (a as string) || (en as string) : (en as string) || (a as string)) ?? '').trim();
  const spacing = sectionSpacingClasses(settings, store.look);
  const oos = resolveProductCardCtaOosDefaults(cardLayout);
  const byId = new Map(products.map(p => [p.id, p]));
  const from = t('From', 'من');

  const looks = blocks
    .filter(b => b.type === 'look' && b.hidden !== true)
    .map(b => {
      const ids = Array.isArray(b.settings.productIds) ? b.settings.productIds : [];
      const pieces = ids
        .map(id => (typeof id === 'string' ? byId.get(id) : undefined))
        .filter((p): p is Product => !!p)
        .map(p => {
          const tp = toTemplateProduct(p);
          const pricing = getProductPricing(tp, undefined, 'card');
          // Same orderable signal as the shared card (X-02: the one stock rule).
          const orderable = canBuyNow(p);
          return { tp, pricing, orderable };
        });
      return {
        id: b.id,
        title: pick(b.settings.title, b.settings.titleAr),
        image: pick(b.settings.image, b.settings.imageAr),
        alt: pick(b.settings.alt, b.settings.altAr),
        pieces,
      };
    })
    .filter(l => l.pieces.length > 0);

  if (looks.length === 0) return editorMode ? <EmptySectionHint kind="shopTheLook" /> : null;
  // Fewer panels than the row holds: centre them instead of leaving an empty tail.
  const centre =
    looks.length < 3 ? (looks.length < 2 ? 'sm:justify-center' : 'lg:justify-center') : '';

  return (
    <section
      data-section="shop-the-look"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        <SectionHeader
          title={pick(settings.heading, settings.headingAr)}
          editTitle={
            editorMode ? { 'data-builder-setting': ar ? 'headingAr' : 'heading' } : undefined
          }
        />
        {/* Native scroll-snap, no JS motion (Ruling B1-7); starts at the inline start in both
            directions (the flex row follows `dir`). */}
        {/* P2-13: prev/next for a mouse without a trackpad (same pair as ProductCarousel). */}
        <div className="relative">
          <ScrollArrows scrollRef={rowRef} isRtl={language === 'ar'} />
          <ul
            ref={rowRef}
            className={`-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:scroll-px-6 sm:gap-6 sm:px-6 lg:mx-0 lg:px-0 ${centre}`}
          >
            {looks.map(l => {
              const buyable = l.pieces.filter(p => p.orderable);
              const total = buyable.reduce((sum, p) => sum + p.pricing.displayPrice, 0);
              const totalFrom = buyable.some(p => p.pricing.mode === 'fromMin');
              return (
                <li
                  key={l.id}
                  data-part="look"
                  {...(editorMode ? { 'data-builder-block': l.id } : undefined)}
                  className={PANEL}
                >
                  <article className="flex h-full flex-col">
                    {l.image && (
                      <div className="relative aspect-[4/5] overflow-hidden rounded-[var(--radius)] bg-muted">
                        <Image
                          src={l.image}
                          alt={l.alt || l.title}
                          fill
                          sizes="(min-width: 1024px) 32vw, (min-width: 640px) 45vw, 85vw"
                          className="object-cover"
                        />
                      </div>
                    )}
                    {l.title && (
                      <h3
                        className="font-display mt-4 text-balance text-xl leading-snug text-foreground"
                        {...(editorMode
                          ? { 'data-builder-setting': ar ? 'titleAr' : 'title' }
                          : undefined)}
                      >
                        {l.title}
                      </h3>
                    )}
                    <ul
                      aria-label={t('Items in this look', 'قطع اللوك')}
                      className="mt-3 divide-y divide-border border-y border-border"
                    >
                      {l.pieces.map(({ tp, pricing, orderable }) => {
                        const name = (ar && tp.nameAr ? tp.nameAr : tp.name) || '';
                        const thumb = tp.images?.[0]?.url;
                        return (
                          <li key={tp.id}>
                            <Link
                              href={storeUrl(`/products/${tp.slug}`)}
                              className="group/row flex min-h-[44px] items-center gap-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="relative aspect-[3/4] w-14 shrink-0 overflow-hidden rounded-[var(--radius)] bg-muted">
                                {thumb && (
                                  <Image
                                    src={thumb}
                                    alt=""
                                    fill
                                    sizes="56px"
                                    className={`object-cover ${orderable ? '' : 'opacity-60'}`}
                                  />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm leading-snug text-foreground transition-colors duration-150 group-hover/row:text-primary">
                                  {name}
                                </span>
                                {!orderable && oos.resolvedOosLabel !== false && (
                                  <span className="mt-0.5 block text-xs text-muted-foreground">
                                    {soldOutLabel(
                                      ar,
                                      oos.resolvedOosLabelTextEn,
                                      oos.resolvedOosLabelTextAr
                                    )}
                                  </span>
                                )}
                              </span>
                              {showPrice && (
                                <span className="flex shrink-0 flex-col items-end text-end">
                                  <span className="whitespace-nowrap text-sm font-medium tabular-nums text-foreground">
                                    {`${pricing.mode === 'fromMin' ? `${from} ` : ''}${formatPrice(pricing.displayPrice)}`}
                                  </span>
                                  {pricing.displayCompare && (
                                    <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground line-through">
                                      {formatPrice(pricing.displayCompare)}
                                    </span>
                                  )}
                                </span>
                              )}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                    {showPrice && buyable.length >= 2 && (
                      <p className="mt-3 flex items-baseline justify-between gap-3 text-sm text-muted-foreground">
                        <span>{t('Look total', 'مجموع اللوك')}</span>
                        <bdi className="whitespace-nowrap font-medium tabular-nums text-foreground">
                          {`${totalFrom ? `${from} ` : ''}${formatPrice(total)}`}
                        </bdi>
                      </p>
                    )}
                    {/* One entry to the whole outfit (W2a, Ahmad 2026-10-16): a quiet secondary
                      link, not a second accent; the page beside it takes a size per piece. Not in
                      the editor canvas, where links are inert anyway. */}
                    {sectionId && !editorMode && (
                      <Link
                        href={storeUrl(lookPanelPath(sectionId, l.id))}
                        data-part="shop-this-look"
                        className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-[var(--radius)] border border-input px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t('See the full look', 'شوف اللوك كامل')}
                      </Link>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
