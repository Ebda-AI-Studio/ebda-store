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
import {
  contrastRatio,
  pickReadableForeground,
  type BlockNode,
  type SectionPaddingMaxWidthVisibility,
  type StoreTheme,
} from '@ebda/shared';
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

/**
 * The band focus ring is TWO-TONE (W2a fix round 1, review M-4): 2px in the band's text colour
 * outside, 2px in the band's fill inside. The two are the band's own pair (>= 3:1 by
 * band-tones-legacy-contrast.test.ts), so over the photo half the ring always shows one tone
 * against the other, whatever the photo.
 */
export const BAND_FOCUS_INNER = {
  primary: 'ring-primary',
  accent: 'ring-accent',
  line: 'ring-border',
} as const;

/** The theme keys each tone paints: [fill, text]. */
const TONE_KEYS = {
  primary: ['primaryColor', 'primaryForeground'],
  accent: ['accentColor', 'accentForeground'],
  line: ['borderColor', 'foregroundColor'],
} as const satisfies Record<string, readonly [keyof StoreTheme, keyof StoreTheme]>;

/**
 * Task 8 review M4 (W2a): a band label is large display text, so its pair must read at >= 3:1 on
 * every skin. A skin whose on-token falls short on its own fill (modern's white on orange is
 * 2.81:1) gets the readable ink for that band instead; every pair that reads is left untouched.
 */
export function bandTextOverride(
  tone: keyof typeof TONE_KEYS,
  theme: Partial<StoreTheme> | undefined
): string | undefined {
  const [fillKey, textKey] = TONE_KEYS[tone];
  const fill = theme?.[fillKey];
  const text = theme?.[textKey];
  if (typeof fill !== 'string' || typeof text !== 'string') return undefined;
  const wrap = (v: string) => (v.startsWith('#') || v.startsWith('hsl(') ? v : `hsl(${v})`);
  if (contrastRatio(wrap(fill), wrap(text)) >= 3) return undefined;
  return pickReadableForeground(wrap(fill)) ?? undefined;
}
type BandTone = keyof typeof BAND_TONES;

/** md+ columns for photo-led occasion tiles (VT-01): one row of up to four. */
const BAND_COLS: Record<number, string> = {
  1: 'md:grid-cols-1',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-4',
};

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
        {/* VT-01 (W2a): photo-led occasion tiles. Below md each band gives its inline-end half
            to the photo at the band's full height; from md the occasions are tall tiles in one
            row, photo on top (4:5) and the band colour as the caption. The photo covers >= 40%
            of every tile at every width; the label carries a chevron so it reads as a link. */}
        <ul
          className={`md:mx-auto md:grid md:max-w-7xl md:gap-4 md:px-6 lg:px-8 ${BAND_COLS[Math.min(4, tiles.length)] ?? BAND_COLS[3]}`}
        >
          {tiles.map((tile, i) => (
            <li
              key={tile.id}
              {...(editorMode ? { 'data-builder-block': tile.id } : undefined)}
              data-tone={tones[i]}
              className={`${BAND_TONES[tones[i]]} md:overflow-hidden md:rounded-[var(--radius)]`}
              style={(() => {
                const color = bandTextOverride(tones[i], store.theme);
                return color ? { color } : undefined;
              })()}
            >
              {/* Focus ring in the band's own text colour (its on-token, >= 4.5:1 on the fill by
                  K-02), inset 4px so it never sits on the neighbouring band (R-11). The global
                  :focus-visible ring is switched off here: it drew a second, offset ring that
                  showed as a dark line at the band's edge (Task 8 deferred minor). */}
              <Link
                href={tile.href}
                data-band-link=""
                className={`grid min-h-40 items-stretch transition-opacity duration-150 active:opacity-80 group/band relative focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 md:flex md:h-full md:min-h-0 md:flex-col ${tile.image ? 'grid-cols-2' : 'grid-cols-1'}`}
              >
                {/* The focus ring is a layer ABOVE the photo (an outline on the link would be
                    painted under the positioned photo and frame only the label half). */}
                <span
                  aria-hidden="true"
                  data-part="band-focus"
                  className={`pointer-events-none absolute inset-1 z-10 border-2 border-current opacity-0 ring-2 ring-inset ${BAND_FOCUS_INNER[tones[i]]} group-focus-visible/band:opacity-100`}
                />
                <span className="flex items-center gap-2 px-4 py-5 sm:px-6 md:order-2 md:px-5 md:py-4">
                  <span className="font-display text-3xl [text-wrap:balance] sm:text-4xl md:text-3xl">
                    {tile.label}
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-5 w-5 shrink-0 rtl:-scale-x-100"
                    aria-hidden="true"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </span>
                {tile.image && (
                  <span
                    data-band-photo=""
                    className="relative block min-h-40 md:order-1 md:aspect-[4/5] md:min-h-0"
                  >
                    <Image
                      src={tile.image}
                      alt=""
                      fill
                      sizes={`(min-width: 768px) ${Math.round(100 / Math.min(4, tiles.length))}vw, 50vw`}
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
            <li key={tile.id} {...(editorMode ? { 'data-builder-block': tile.id } : undefined)}>
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
