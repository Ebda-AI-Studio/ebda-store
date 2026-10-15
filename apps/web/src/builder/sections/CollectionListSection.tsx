'use client';

/**
 * `collection-list` (builder Phase 3 pilot, document-only): tiles that open a
 * category, one `collection` block each (category reference + optional
 * image and label override). A tile without its own image or label borrows
 * the category's; a reference to a category this store does not have still
 * renders but opens the full catalogue (the validator warns the editor).
 */
import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { BlockNode, SectionPaddingMaxWidthVisibility } from '@ebda/shared';
import type { Category } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { countText, PIECES } from '../../lib/plural';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { DahabTile, type DahabTileShape } from '../../templates/dahab/CategoryCard';
import { getPackStyles } from '../../templates/shared/pack-styles';
import { SectionHeader } from './SectionHeader';

export interface CollectionListSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  /** `'band'` = one full-width colour band per block (Ruling B1-2, Vitrine's occasions). */
  tileShape?: DahabTileShape | 'band';
  columns?: number;
  bgColor?: string;
}

/**
 * Band fills, each paired with its on-token (quality bar K-02). `line` reads `--border`, which a
 * look composes from its `line` token (Vitrine: champagne, Ruling B1-5); legacy skins define
 * `--border` and `--accent-foreground` too, so a band renders on every skin.
 */
export const BAND_TONES = {
  primary: 'bg-primary text-primary-foreground',
  accent: 'bg-accent text-accent-foreground',
  line: 'bg-border text-foreground',
} as const;
const TONE_CYCLE = ['primary', 'accent', 'line'] as const;
type BandTone = keyof typeof BAND_TONES;

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
  const title = pick(settings.heading, settings.headingAr);
  const editTitle = editorMode
    ? { 'data-builder-setting': ar ? 'headingAr' : 'heading' }
    : undefined;

  if (settings.tileShape === 'band') {
    const toneOf = (id: string, i: number): BandTone => {
      const raw = blocks.find(b => b.id === id)?.settings.tone;
      return typeof raw === 'string' && raw in BAND_TONES
        ? (raw as BandTone)
        : TONE_CYCLE[i % TONE_CYCLE.length];
    };
    const tones = tiles.map((tile, i) => toneOf(tile.id, i));
    return (
      <section
        data-section="collection-list"
        data-tile-shape="band"
        className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
        style={sectionBgStyle(settings.bgColor, store.theme)}
      >
        {title && (
          <div className={spacing.innerContainerClass}>
            {/* Bands run edge to edge, so the heading follows the pack's heading alignment
                (start on qamar) and lines up with the band labels. */}
            <SectionHeader
              title={title}
              center={getPackStyles(store.template).sectionHeadingAlign !== 'start'}
              editTitle={editTitle}
            />
          </div>
        )}
        <ul>
          {tiles.map((tile, i) => (
            <li key={tile.id} data-tone={tones[i]} className={BAND_TONES[tones[i]]}>
              {/* Focus ring in the band's own text colour (its on-token, >= 4.5:1 on the fill by
                  K-02), inset so it never sits on the neighbouring band (R-11). */}
              <Link
                href={tile.href}
                className="mx-auto grid max-w-7xl grid-cols-[1fr_auto] items-center gap-4 px-4 py-5 transition-opacity duration-150 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-current sm:px-6 lg:px-8"
              >
                <span className="font-display text-3xl [text-wrap:balance] sm:text-4xl">
                  {tile.label}
                </span>
                {tile.image && (
                  <span className="relative block h-28 w-20 overflow-hidden rounded-[var(--radius)] sm:h-40 sm:w-28">
                    <Image
                      src={tile.image}
                      alt=""
                      fill
                      sizes="(min-width: 640px) 112px, 80px"
                      className="object-cover"
                    />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const cols = settings.columns ?? Math.min(4, tiles.length);

  return (
    <section
      data-section="collection-list"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        <SectionHeader title={title} center editTitle={editTitle} />
        <ul className={`grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 ${COLS[cols] ?? COLS[4]}`}>
          {tiles.map(tile => (
            <li key={tile.id}>
              <DahabTile
                href={tile.href}
                image={tile.image}
                label={tile.label}
                meta={tile.meta}
                shape={(settings.tileShape as DahabTileShape | undefined) ?? 'arch'}
                sizes={`(min-width: 768px) ${Math.round(100 / cols)}vw, 50vw`}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
