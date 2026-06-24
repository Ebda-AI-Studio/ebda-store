'use client';

import Link from 'next/link';
import type { EmptyStateProps } from '../types';
import { useRtlText } from '../shared/useRtlText';

export default function BoldEmptyState({
  title,
  titleAr,
  description,
  descriptionAr,
  ctaLabel,
  ctaLabelAr,
  ctaHref,
  onCtaClick,
  icon,
  isRtl: isRtlProp,
}: EmptyStateProps) {
  const { isRtl, displayTitle, displayDescription, displayCta } = useRtlText({
    title,
    titleAr,
    description,
    descriptionAr,
    ctaLabel,
    ctaLabelAr,
    isRtl: isRtlProp,
  });

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="flex flex-col items-center justify-center border-2 border-foreground bg-background py-16 px-6 text-center"
      role="status"
    >
      {icon ?? (
        <svg
          className="h-16 w-16 text-foreground"
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      )}
      <h2 className="mt-6 text-2xl font-black uppercase tracking-tight text-foreground">
        {displayTitle}
      </h2>
      {displayDescription && (
        <p className="mt-3 max-w-md text-sm font-bold uppercase tracking-wider text-muted-foreground">
          {displayDescription}
        </p>
      )}
      {displayCta &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-8 inline-flex h-12 items-center bg-primary px-8 text-sm font-black uppercase tracking-widest text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
          >
            {displayCta} →
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            className="mt-8 inline-flex h-12 items-center bg-primary px-8 text-sm font-black uppercase tracking-widest text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
          >
            {displayCta} →
          </button>
        ))}
    </div>
  );
}
