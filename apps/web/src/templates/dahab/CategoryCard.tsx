'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { CategoryCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { cx } from './ui';

export type DahabTileShape = 'arch' | 'rectangle' | 'circle';

const SHAPE: Record<DahabTileShape, { frame: string; aspect: string }> = {
  // The arch: a vitrine / mihrab outline, Dahab's one signature shape.
  arch: { frame: 'rounded-t-[999px] rounded-b-[var(--radius)]', aspect: 'aspect-[3/4]' },
  rectangle: { frame: 'rounded-[var(--radius)]', aspect: 'aspect-[4/5]' },
  circle: { frame: 'rounded-full', aspect: 'aspect-square' },
};

/** A collection tile: photograph in an arch, name below in the display face. */
export function DahabTile({
  href,
  image,
  label,
  meta,
  shape = 'arch',
  sizes = '(min-width: 1024px) 22vw, 45vw',
}: {
  href: string;
  image?: string;
  label: string;
  meta?: string;
  shape?: DahabTileShape;
  sizes?: string;
}) {
  const s = SHAPE[shape];
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
          <div aria-hidden="true" className="absolute inset-0 bg-muted" />
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
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const label = (isRtl && category.nameAr ? category.nameAr : category.name) || '';
  const count = category.productCount;
  return (
    <DahabTile
      href={`${urlPrefix}/products?category=${encodeURIComponent(category.slug)}`}
      image={category.image}
      label={label}
      meta={count ? `${localize(count)} ${t('pieces', 'قطعة')}` : undefined}
    />
  );
}
