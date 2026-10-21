'use client';

import Link from 'next/link';
import type { EmptyStateProps } from '../types';
import { useRtlText } from '../shared/useRtlText';
import { ArrowIcon } from '../shared/icons';

export default function ElegantEmptyState({
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
  // a11y re-audit P2-N6: the arrow is the mirroring icon on every store (rtlPolish no longer
  // decides it; a glyph arrow pointed the wrong way in Arabic unless that flag was on).

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="flex flex-col items-center justify-center py-24 px-6 text-center"
      role="status"
    >
      {icon ?? (
        <svg
          className="h-8 w-8 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={1}
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.172 16.172a4 4 0 015.656 0M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )}
      <h2 className="mt-8 text-xs font-light uppercase tracking-[0.3em] text-muted-foreground">
        {displayTitle}
      </h2>
      {displayDescription && (
        <p className="mt-4 max-w-md text-sm font-light tracking-wide text-foreground">
          {displayDescription}
        </p>
      )}
      {displayCta &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            data-cta="link"
            className="group mt-10 inline-flex min-h-11 items-center gap-2 text-xs font-light uppercase tracking-[0.3em] text-foreground hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          >
            <span className="border-b border-foreground pb-1 group-hover:border-primary">
              {displayCta}
            </span>
            <ArrowIcon className="h-4 w-4 shrink-0" isRtl={isRtl} />
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            data-cta="link"
            className="group mt-10 inline-flex min-h-11 items-center gap-2 text-xs font-light uppercase tracking-[0.3em] text-foreground hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          >
            <span className="border-b border-foreground pb-1 group-hover:border-primary">
              {displayCta}
            </span>
            <ArrowIcon className="h-4 w-4 shrink-0" isRtl={isRtl} />
          </button>
        ))}
    </div>
  );
}
