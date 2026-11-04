'use client';

/**
 * `featured-collection` (builder Phase 3 pilot, document-only): a product
 * grid bound to a source (newest / best sellers / featured / one category /
 * hand-picked), with desktop and mobile column counts and a "view all" link.
 * Cards are the platform card, so each skin draws its own (Dahab's included).
 */
import { fitDesktopColumns } from '../../templates/shared/grid-helpers';
import React from 'react';
import type { SectionPaddingMaxWidthVisibility, TemplateId } from '@ebda/shared';
import { sanitizeUrl } from '@ebda/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { StorefrontProductCard } from '../../templates/shared/StorefrontProductCard';
import type { TemplateProduct } from '../../templates/types';
import { SectionHeader } from './SectionHeader';
import type { SectionProductRefs } from './section-products';

export interface FeaturedCollectionSettings
  extends SectionPaddingMaxWidthVisibility, SectionProductRefs {
  heading?: string;
  headingAr?: string;
  subheading?: string;
  subheadingAr?: string;
  columns?: number;
  mobileColumns?: number;
  /** `menu` renders MenuSection (dish rows under category tabs); absent / `grid` = this grid. */
  layout?: 'grid' | 'menu';
  tabs?: 'categories' | 'none';
  buttonText?: string;
  buttonTextAr?: string;
  buttonLink?: string;
  bgColor?: string;
}

const DESKTOP: Record<number, string> = {
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
};

/** Columns at each breakpoint: phone (1|2), md (2|3), lg (the section's columns). */
export interface GridColumns {
  base: number;
  md: number;
  lg: number;
}

// Literal class tables (Tailwind scans literals): the centring grid has TWO tracks per card.
const HALF_GRID = {
  base: { 1: 'grid-cols-2', 2: 'grid-cols-4' } as Record<number, string>,
  md: { 2: 'md:grid-cols-4', 3: 'md:grid-cols-6' } as Record<number, string>,
  lg: {
    2: 'lg:grid-cols-4',
    3: 'lg:grid-cols-6',
    4: 'lg:grid-cols-8',
    5: 'lg:grid-cols-10',
  } as Record<number, string>,
};
const START = {
  base: { 2: 'col-start-2' } as Record<number, string>,
  md: { 2: 'md:col-start-2', 3: 'md:col-start-3' } as Record<number, string>,
  lg: {
    2: 'lg:col-start-2',
    3: 'lg:col-start-3',
    4: 'lg:col-start-4',
    5: 'lg:col-start-5',
  } as Record<number, string>,
};
const AUTO = { base: '', md: 'md:col-start-auto', lg: 'lg:col-start-auto' };
const BPS = ['base', 'md', 'lg'] as const;

/**
 * Quality bar L-05 (Ruling B1-40 as re-ruled): a product grid never ends on an orphan row, and
 * NEVER hides a product. When some breakpoint has an incomplete last row, the grid switches to
 * two tracks per card (`col-span-2`, so every card keeps the merchant's column width) and the
 * first card of that last row starts `columns - remainder` tracks in: the incomplete row is
 * centred (logical lines, so it centres in Arabic too). A count that fills every breakpoint
 * returns null and the grid renders exactly as before.
 */
export function centredGrid(
  count: number,
  columns: GridColumns
): { grid: string; item: (index: number) => string } | null {
  const rem = (c: number) => count % c;
  if (BPS.every(bp => rem(columns[bp]) === 0)) return null;
  const grid = BPS.map(bp => HALF_GRID[bp][columns[bp]]).join(' ');
  return {
    grid,
    item: (index: number) => {
      const cls = ['col-span-2'];
      let shifted = false;
      for (const bp of BPS) {
        const c = columns[bp];
        const r = rem(c);
        if (r !== 0 && index === count - r) {
          cls.push(START[bp][c - r + 1]);
          shifted = true;
        } else if (shifted && AUTO[bp]) cls.push(AUTO[bp]);
      }
      return cls.join(' ');
    },
  };
}

export function FeaturedCollectionSection({
  settings,
  products,
  pack,
  onAddToCart,
  editorMode = false,
}: {
  settings: FeaturedCollectionSettings;
  products: TemplateProduct[];
  pack: TemplateId;
  onAddToCart: (productId: string) => Promise<void>;
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const pick = (en?: string, a?: string) => (ar ? a || en : en || a) || '';
  const edit = (key: string): Record<string, string> | undefined =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : undefined;
  const spacing = sectionSpacingClasses(settings, store.look);
  if (products.length === 0) return null;
  const cols = fitDesktopColumns(products.length, settings.columns ?? 4);
  const centred = centredGrid(products.length, {
    base: settings.mobileColumns === 1 ? 1 : 2,
    md: cols >= 3 ? 3 : 2,
    lg: DESKTOP[cols] ? cols : 4,
  });
  const button = pick(settings.buttonText, settings.buttonTextAr);
  const link = settings.buttonLink
    ? storeUrl(sanitizeUrl(settings.buttonLink, '/products'))
    : storeUrl(
        settings.productSource === 'category' && settings.categorySlug
          ? `/products?category=${encodeURIComponent(settings.categorySlug)}`
          : '/products'
      );

  return (
    <section
      data-section="featured-collection"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        <SectionHeader
          title={pick(settings.heading, settings.headingAr)}
          subtitle={pick(settings.subheading, settings.subheadingAr) || undefined}
          linkLabel={button || t('View all', 'عرض الكل')}
          linkHref={link}
          editTitle={edit('heading')}
          editSubtitle={edit('subheading')}
          editLink={edit('buttonText')}
        />
        <div
          data-part="product-grid"
          className={[
            'grid gap-x-3 gap-y-8 sm:gap-x-5 sm:gap-y-10',
            centred
              ? centred.grid
              : [
                  settings.mobileColumns === 1 ? 'grid-cols-1' : 'grid-cols-2',
                  cols >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
                  DESKTOP[cols] ?? DESKTOP[4],
                ].join(' '),
          ].join(' ')}
        >
          {products.map((p, i) => {
            const card = (
              <StorefrontProductCard
                key={p.id}
                product={p}
                pack={pack}
                isRtl={ar}
                currency={store.currency}
                urlPrefix={storeUrl('')}
                onAddToCart={onAddToCart}
              />
            );
            // The wrapper is a one-cell grid so the card stretches to the row height, like a
            // direct grid child: cards in a row keep equal heights and shared action baselines
            // (quality bar L-06).
            return centred ? (
              <div key={p.id} className={`${centred.item(i)} grid`}>
                {card}
              </div>
            ) : (
              card
            );
          })}
        </div>
      </div>
    </section>
  );
}
