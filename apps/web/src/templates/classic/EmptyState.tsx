'use client';

import Link from 'next/link';
import type { EmptyStateProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ClassicEmptyState({
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
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayTitle = isRtl ? (titleAr ?? title) : (title ?? titleAr);
  const displayDescription = isRtl
    ? (descriptionAr ?? description)
    : (description ?? descriptionAr);
  const displayCta = isRtl ? (ctaLabelAr ?? ctaLabel) : (ctaLabel ?? ctaLabelAr);

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="flex flex-col items-center justify-center border border-border bg-background py-16 px-6 text-center"
      role="status"
    >
      {icon ?? (
        <svg
          className="h-12 w-12 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      )}
      <h2 className="mt-6 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {displayTitle}
      </h2>
      {displayDescription && (
        <p className="mt-3 max-w-md text-sm tracking-tight text-foreground">{displayDescription}</p>
      )}
      {displayCta &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-8 inline-flex h-11 items-center border border-foreground bg-foreground px-6 text-xs font-semibold uppercase tracking-widest text-background hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
          >
            {displayCta}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            className="mt-8 inline-flex h-11 items-center border border-foreground bg-foreground px-6 text-xs font-semibold uppercase tracking-widest text-background hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
          >
            {displayCta}
          </button>
        ))}
    </div>
  );
}
