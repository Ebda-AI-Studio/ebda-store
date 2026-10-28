'use client';

import Link from '../../components/StoreLink';
import type { EmptyStateProps } from '../types';
import { useRtlText } from '../shared/useRtlText';
import { DAHAB_BTN_SECONDARY } from './ui';

export default function DahabEmptyState({
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
      className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center"
    >
      {icon && <div className="mb-6 text-primary [&_svg]:h-10 [&_svg]:w-10">{icon}</div>}
      <span aria-hidden="true" className="mb-6 block h-px w-12 bg-primary" />
      <h2 className="font-display text-3xl text-foreground rtl:text-[2rem] rtl:leading-snug">
        {displayTitle}
      </h2>
      {displayDescription && (
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          {displayDescription}
        </p>
      )}
      {displayCta &&
        (ctaHref ? (
          <Link href={ctaHref} className={`${DAHAB_BTN_SECONDARY} mt-8`}>
            {displayCta}
          </Link>
        ) : (
          <button type="button" onClick={onCtaClick} className={`${DAHAB_BTN_SECONDARY} mt-8`}>
            {displayCta}
          </button>
        ))}
    </div>
  );
}
