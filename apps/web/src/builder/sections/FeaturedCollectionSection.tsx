'use client';

/**
 * `featured-collection` (builder Phase 3 pilot, document-only): a product
 * grid bound to a source (newest / best sellers / featured / one category /
 * hand-picked), with desktop and mobile column counts and a "view all" link.
 * Cards are the platform card, so each skin draws its own (Dahab's included).
 */
import React from 'react';
import type { SectionPaddingMaxWidthVisibility, TemplateId } from '@ebda/shared';
import { sanitizeUrl } from '@ebda/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { PecannbeeProductCard } from '../../templates/shared/PecannbeeProductCard';
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

/**
 * Quality bar L-05: a product grid never ends on an orphan row. Per breakpoint, cards past the
 * last FULL row are hidden (a grid shorter than one row shows whole). Only cards that must hide
 * somewhere get a `display: contents` wrapper, so a count that divides every breakpoint's column
 * count renders exactly the markup it always did. Tailwind literals: hidden contents md:hidden
 * md:contents lg:hidden lg:contents.
 */
export function orphanRowClass(
  index: number,
  count: number,
  columns: { base: number; md: number; lg: number }
): string | undefined {
  const shown = (c: number) => (count >= c ? Math.floor(count / c) * c : count);
  const vis = [index < shown(columns.base), index < shown(columns.md), index < shown(columns.lg)];
  if (vis.every(Boolean)) return undefined;
  return [
    vis[0] ? 'contents' : 'hidden',
    vis[1] ? 'md:contents' : 'md:hidden',
    vis[2] ? 'lg:contents' : 'lg:hidden',
  ].join(' ');
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
  const cols = settings.columns ?? 4;
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
          className={[
            'grid gap-x-3 gap-y-8 sm:gap-x-5 sm:gap-y-10',
            settings.mobileColumns === 1 ? 'grid-cols-1' : 'grid-cols-2',
            cols >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
            DESKTOP[cols] ?? DESKTOP[4],
          ].join(' ')}
        >
          {products.map((p, i) => {
            const card = (
              <PecannbeeProductCard
                key={p.id}
                product={p}
                pack={pack}
                isRtl={ar}
                currency={store.currency}
                urlPrefix={storeUrl('')}
                onAddToCart={onAddToCart}
              />
            );
            const trim = orphanRowClass(i, products.length, {
              base: settings.mobileColumns === 1 ? 1 : 2,
              md: cols >= 3 ? 3 : 2,
              lg: DESKTOP[cols] ? cols : 4,
            });
            return trim ? (
              <div key={p.id} className={trim} data-orphan-trim>
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
