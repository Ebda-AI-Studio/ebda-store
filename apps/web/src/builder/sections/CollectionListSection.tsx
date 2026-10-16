'use client';

/**
 * `collection-list` (builder Phase 3 pilot, document-only): tiles that open a
 * category, one `collection` block each (category reference + optional
 * image and label override). A tile without its own image or label borrows
 * the category's; a reference to a category this store does not have still
 * renders but opens the full catalogue (the validator warns the editor).
 */
import React from 'react';
import type { BlockNode, SectionPaddingMaxWidthVisibility } from '@ebda/shared';
import type { Category } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { countText, PIECES } from '../../lib/plural';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { DahabTile, type DahabTileShape } from '../../templates/dahab/CategoryCard';
import { SectionHeader } from './SectionHeader';

export interface CollectionListSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  tileShape?: DahabTileShape;
  columns?: number;
  bgColor?: string;
}

const COLS: Record<number, string> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-4',
};

export function CollectionListSection({
  settings,
  blocks,
  categories,
  editorMode = false,
}: {
  settings: CollectionListSettings;
  blocks: BlockNode[];
  categories: Category[];
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language } = useLanguage();
  const { localize } = useNumerals();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const pick = (en?: unknown, a?: unknown) =>
    ((ar ? (a as string) || (en as string) : (en as string) || (a as string)) ?? '').trim();
  const spacing = sectionSpacingClasses(settings, store.look);
  const bySlug = new Map(categories.map(c => [c.slug, c]));

  const tiles = blocks
    .filter(b => b.type === 'collection' && b.hidden !== true)
    .map(b => {
      const slug = typeof b.settings.categorySlug === 'string' ? b.settings.categorySlug : '';
      const cat = slug ? bySlug.get(slug) : undefined;
      const label = pick(b.settings.label, b.settings.labelAr) || pick(cat?.name, cat?.nameAr);
      const image = pick(b.settings.image, b.settings.imageAr) || cat?.image || '';
      const count = cat as { _count?: { products?: number }; productCount?: number } | undefined;
      const n = count?.productCount ?? count?._count?.products;
      return {
        id: b.id,
        label,
        image,
        href: cat
          ? storeUrl(`/products?category=${encodeURIComponent(cat.slug)}`)
          : storeUrl('/products'),
        meta: n ? countText(language === 'ar' ? 'ar' : 'en', n, PIECES, localize(n)) : undefined,
      };
    })
    .filter(tile => tile.label);
  if (tiles.length === 0) return null;
  const cols = settings.columns ?? Math.min(4, tiles.length);

  return (
    <section
      data-section="collection-list"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        <SectionHeader
          title={pick(settings.heading, settings.headingAr)}
          center
          editTitle={
            editorMode ? { 'data-builder-setting': ar ? 'headingAr' : 'heading' } : undefined
          }
        />
        <ul className={`grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 ${COLS[cols] ?? COLS[4]}`}>
          {tiles.map(tile => (
            <li key={tile.id}>
              <DahabTile
                href={tile.href}
                image={tile.image}
                label={tile.label}
                meta={tile.meta}
                shape={settings.tileShape ?? 'arch'}
                sizes={`(min-width: 768px) ${Math.round(100 / cols)}vw, 50vw`}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
