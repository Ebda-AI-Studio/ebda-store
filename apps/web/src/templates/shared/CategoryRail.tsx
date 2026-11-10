'use client';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import { useStore } from '../../contexts/StoreContext';
import { SectionHeading } from './SectionHeading';
import { pickLocalizedName } from './display-helpers';
import type { CategoryStripProps } from '../types';

/**
 * Category rail (`category-grid` layout `rail`, Phase B2, Souq Catalogue): one horizontal snap row
 * of image tiles, a product cut-out on the surface token (`object-contain`, never cropped), the
 * name under it. Built for "find it in two taps": the whole row is visible-and-scrollable at 390,
 * the thin scrollbar is the cue that it scrolls, every tile is a >= 44px target, and the row
 * never makes the PAGE scroll sideways (`overflow-x-auto` is on the row, `min-w-0` on its parent).
 * Logical properties throughout: an Arabic row starts at the right.
 */
export function CategoryRail({
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
}: CategoryStripProps) {
  const { store } = useStore();
  if (!categories || categories.length === 0) return null;
  return (
    <section
      className="px-4 sm:px-6 lg:px-8"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="categories"
      data-section="category-rail"
    >
      <div className="mx-auto min-w-0 max-w-7xl">
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
          <ul
            className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4 [scroll-padding-inline:1rem] [scrollbar-width:thin] sm:-mx-6 sm:px-6 sm:[scroll-padding-inline:1.5rem] lg:mx-0 lg:px-0"
            data-part="rail-row"
          >
            {categories.map(c => {
              const name = pickLocalizedName(c, Boolean(isRtl)) ?? c.name;
              return (
                <li key={c.id} className="w-24 shrink-0 snap-start sm:w-28">
                  <Link
                    href={`${urlPrefix}/products?category=${encodeURIComponent(c.slug ?? c.id)}`}
                    prefetch={false}
                    className="group flex min-h-11 flex-col items-center gap-2 rounded-[var(--radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span className="relative block aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-card">
                      {c.image ? (
                        <Image
                          src={c.image}
                          alt=""
                          fill
                          sizes="(min-width: 640px) 112px, 96px"
                          className="object-contain p-2"
                        />
                      ) : (
                        <span
                          data-part="typographic"
                          className="flex h-full w-full items-center justify-center p-2 text-center font-display text-sm leading-snug text-foreground"
                        >
                          <span className="line-clamp-3">{name}</span>
                        </span>
                      )}
                    </span>
                    {c.image && (
                      <span className="line-clamp-2 text-center text-sm font-medium leading-snug text-foreground">
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
