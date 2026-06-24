'use client';

import Link from 'next/link';
import type { EmptyStateProps } from '../types';
import { useRtlText } from '../shared/useRtlText';

const DefaultIcon = () => (
  <svg
    className="h-16 w-16 text-muted-foreground/60"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.2}
      d="M20 13V7a2 2 0 00-2-2H6a2 2 0 00-2 2v6m16 0l-4 8-4-8m8 0H4m4 0l4 8"
    />
  </svg>
);

export default function ModernEmptyState({
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
      className="flex flex-col items-center justify-center rounded-2xl border border-border/60 bg-card py-16 px-6 text-center"
      role="status"
    >
      <div className="rounded-full bg-primary/5 p-6">{icon ?? <DefaultIcon />}</div>
      <h2 className="mt-6 text-xl font-semibold text-foreground">{displayTitle}</h2>
      {displayDescription && (
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{displayDescription}</p>
      )}
      {displayCta &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-6 inline-flex h-11 items-center rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {displayCta}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            className="mt-6 inline-flex h-11 items-center rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {displayCta}
          </button>
        ))}
    </div>
  );
}
