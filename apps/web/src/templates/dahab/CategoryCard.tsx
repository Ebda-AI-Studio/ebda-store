'use client';

import Image from 'next/image';
import Link from '../../components/StoreLink';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { countText, PIECES } from '../../lib/plural';
import { cx } from './ui';
import { MissingImage } from '../shared/MissingImage';
import { CATEGORY_TILE_SIZES } from '../../lib/image-sizes';

/**
 * `'arch'` is accepted so a saved page document keeps validating and rendering (Ruling B5-3), but
 * it is never drawn: the arch frame was the retired skin's signature, and a stored `'arch'` renders
 * as the look's rectangle.
 */
export type DahabTileShape = 'arch' | 'rectangle' | 'circle';

const SHAPE: Record<'rectangle' | 'circle', { frame: string; aspect: string }> = {
  rectangle: { frame: 'rounded-[var(--radius)]', aspect: 'aspect-[4/5]' },
  circle: { frame: 'rounded-full', aspect: 'aspect-square' },
};

/** A collection tile: the photograph in the look's frame, name below in the display face. */
export function DahabTile({
  href,
  image,
  label,
  meta,
  shape = 'rectangle',
  sizes = CATEGORY_TILE_SIZES,
}: {
  href: string;
  image?: string;
  label: string;
  meta?: string;
  shape?: DahabTileShape;
  sizes?: string;
}) {
  const s = SHAPE[shape === 'circle' ? 'circle' : 'rectangle'];
  return (
    <Link
      href={href}
      prefetch={false}
      className="group/tile block rounded-[var(--radius)] text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      <div
        className={cx(
          'relative w-full overflow-hidden bg-card ring-1 ring-inset ring-primary/25',
          s.frame,
          s.aspect
        )}
      >
        {image ? (
          <Image
            src={image}
            alt=""
            fill
            sizes={sizes}
            className="object-cover transition-transform duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:group-hover/tile:scale-[1.05]"
          />
        ) : (
          <MissingImage label={label} />
        )}
        <span
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute inset-1.5 border border-primary/0 transition-colors duration-500 group-hover/tile:border-primary/50',
            s.frame
          )}
        />
      </div>
      <p className="font-display mt-4 text-[17px] leading-tight text-foreground transition-colors group-hover/tile:text-primary sm:text-lg rtl:text-xl">
        {label}
      </p>
      {meta && <p className="mt-1 text-xs tabular-nums text-muted-foreground">{meta}</p>}
    </Link>
  );
}

export default function DahabCategoryCard({
  category,
  isRtl: isRtlProp,
  urlPrefix = '',
}: CategoryCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const label = (isRtl && category.nameAr ? category.nameAr : category.name) || '';
  const count = category.productCount;
  return (
    <DahabTile
      href={`${urlPrefix}/products?category=${encodeURIComponent(category.slug)}`}
      image={category.image}
      label={label}
      meta={count ? countText(isRtl ? 'ar' : 'en', count, PIECES, localize(count)) : undefined}
    />
  );
}
