'use client';

import Link from 'next/link';
import type { EmptyStateProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

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
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayTitle = isRtl ? (titleAr ?? title) : (title ?? titleAr);
  const displayDescription = isRtl
    ? (descriptionAr ?? description)
    : (description ?? descriptionAr);
  const displayCta = isRtl ? (ctaLabelAr ?? ctaLabel) : (ctaLabel ?? ctaLabelAr);

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="flex flex-col items-start py-20" role="status">
      {icon}
      <h2 className="text-2xl text-foreground">{displayTitle}</h2>
      {displayDescription && (
        <p className="mt-3 max-w-md text-sm text-muted-foreground">{displayDescription}</p>
      )}
      {displayCta &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-8 border-b border-foreground pb-1 text-sm text-foreground hover:border-primary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          >
            {displayCta} →
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            className="mt-8 border-b border-foreground pb-1 text-sm text-foreground hover:border-primary hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          >
            {displayCta} →
          </button>
        ))}
    </div>
  );
}
