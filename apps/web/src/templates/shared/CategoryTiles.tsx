'use client';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import { useStore } from '../../contexts/StoreContext';
import { SectionHeading } from './SectionHeading';
import { pickLocalizedName } from './display-helpers';
import type { CategoryStripProps } from '../types';

/**
 * Aisle tint (Phase B4, Ruling B4-2): a 20% wash of one aisle colour over the page (taste P2: 13% read as an empty pale frame); the still
 * is cropped to the tile and multiplied into the wash, so a photo shot on white takes the aisle colour. The name
 * is ALWAYS present and ink-coloured, so colour never carries the meaning alone; the washes stay
 * above 10:1 for ink (checked in tests/unit/lamma-variants-render.test.tsx for the Market aisles).
 */
export const AISLE_TINT_PERCENT = 20;
export const aisleTint = (hex: string) =>
  `color-mix(in srgb, ${hex} ${AISLE_TINT_PERCENT}%, hsl(var(--background)))`;

// Tile widths for a wrapping, CENTRED row (STOP-2 re-audit): seven categories at four across end
// in a centred row of three instead of a left-hugging orphan. gap-3 = 0.75rem.
const MOBILE_W: Record<number, string> = {
  1: 'w-full',
  2: 'w-[calc(50%-0.375rem)]',
  3: 'w-[calc(33.333%-0.5rem)]',
};
const DESKTOP_W: Record<number, string> = {
  2: 'md:w-[calc(50%-0.375rem)]',
  3: 'md:w-[calc(33.333%-0.5rem)]',
  4: 'md:w-[calc(25%-0.5625rem)]',
};

/**
 * Category tiles (`category-grid` layout `tiles`, Phase B2, Souq Night souq): bold SQUARE tiles.
 * A category photo is shown whole (`object-contain` cut-out on the surface token); a category
 * with no photo renders a typographic tile (its name in the display face) instead of a blank
 * square. `captionPosition` is honoured: `below` puts the name under the tile, `overlay` on a
 * solid page-colour band at the tile's bottom edge (token colours only, always readable).
 */
export function CategoryTiles({
  categories,
  title,
  titleAr,
  kicker,
  kickerAr,
  subtitle,
  subtitleAr,
  showKickerLines,
  showSubtitleLines,
  dividers,
  seeAllHref,
  isRtl,
  urlPrefix = '',
  pack,
  headingZone,
  kickerZone,
  subtitleZone,
  seeAllZone,
  sectionBgColor,
  captionPosition = 'below',
  mobileColumns = 2,
  desktopColumns = 4,
  tint,
  aisles,
}: CategoryStripProps & {
  mobileColumns?: number;
  desktopColumns?: number;
  /** `aisles` washes each tile in the look's aisle colours in turn; absent = the card surface. */
  tint?: 'none' | 'aisles';
  aisles?: readonly string[];
}) {
  const { store } = useStore();
  if (!categories || categories.length === 0) return null;
  const overlay = captionPosition === 'overlay';
  return (
    <section
      className="px-4 sm:px-6 lg:px-8"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="categories"
      data-section="category-tiles"
    >
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          title={title}
          titleAr={titleAr}
          kicker={kicker}
          kickerAr={kickerAr}
          subtitle={subtitle}
          subtitleAr={subtitleAr}
          showKickerLines={showKickerLines}
          showSubtitleLines={showSubtitleLines}
          dividers={dividers}
          isRtl={isRtl}
          seeAllHref={seeAllHref}
          pack={pack}
          headingZone={headingZone}
          kickerZone={kickerZone}
          subtitleZone={subtitleZone}
          seeAllZone={seeAllZone}
          sectionBgColor={store?.look ? sectionBgColor : undefined}
        />
        <nav aria-label={isRtl ? 'الأقسام' : 'Categories'}>
          <ul className="flex flex-wrap justify-center gap-3">
            {categories.map((c, index) => {
              const name = pickLocalizedName(c, Boolean(isRtl)) ?? c.name;
              const wash =
                tint === 'aisles' && aisles && aisles.length > 0
                  ? aisleTint(aisles[index % aisles.length])
                  : undefined;
              return (
                <li
                  key={c.id}
                  className={`${MOBILE_W[mobileColumns] ?? MOBILE_W[2]} ${DESKTOP_W[desktopColumns] ?? DESKTOP_W[4]}`}
                >
                  <Link
                    href={`${urlPrefix}/products?category=${encodeURIComponent(c.slug ?? c.id)}`}
                    prefetch={false}
                    className="group flex min-h-11 flex-col gap-2 rounded-[var(--radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span
                      className="relative block aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-card"
                      data-part="tile"
                      data-aisle={wash ? index % (aisles?.length ?? 1) : undefined}
                      style={wash ? { backgroundColor: wash } : undefined}
                    >
                      {c.image ? (
                        <Image
                          src={c.image}
                          alt=""
                          fill
                          sizes="(min-width: 768px) 25vw, 50vw"
                          className={
                            wash ? 'object-cover mix-blend-multiply' : 'object-contain p-3'
                          }
                        />
                      ) : (
                        <span
                          data-part="typographic"
                          className="flex h-full w-full items-center justify-center p-3 text-center font-display text-xl leading-snug text-foreground sm:text-2xl"
                        >
                          {name}
                        </span>
                      )}
                      {overlay && c.image && (
                        <span className="absolute inset-x-0 bottom-0 bg-background px-3 py-2 text-sm font-medium leading-snug text-foreground">
                          {name}
                        </span>
                      )}
                    </span>
                    {!overlay && c.image && (
                      <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                        {name}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </section>
  );
}
