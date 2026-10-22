'use client';

import Link from 'next/link';
import type { EmptyStateProps } from '../types';
import { useRtlText } from '../shared/useRtlText';
import { ArrowIcon } from '../shared/icons';

export default function MinimalEmptyState({
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
      className="flex flex-col items-start py-10 sm:py-20"
      role="status"
    >
      {icon}
      <h2 className="text-2xl text-foreground">{displayTitle}</h2>
      {displayDescription && (
        <p className="mt-3 max-w-md text-sm text-muted-foreground">{displayDescription}</p>
      )}
      {displayCta &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            data-cta="link"
            className="group mt-8 inline-flex min-h-11 items-center gap-2 text-sm text-foreground hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
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
            className="group mt-8 inline-flex min-h-11 items-center gap-2 text-sm text-foreground hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
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
