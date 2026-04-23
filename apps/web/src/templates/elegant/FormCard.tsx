'use client';

import type { FormCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ElegantFormCard({
  title,
  titleAr,
  subtitle,
  subtitleAr,
  children,
  footer,
  isRtl: isRtlProp,
}: FormCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayTitle = isRtl ? (titleAr ?? title) : (title ?? titleAr);
  const displaySubtitle = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="w-full max-w-md">
      <header className="mb-10 text-center">
        <h1 className="text-3xl font-light tracking-wide text-foreground">{displayTitle}</h1>
        {displaySubtitle && (
          <p className="mt-4 text-xs font-light uppercase tracking-[0.3em] text-muted-foreground">
            {displaySubtitle}
          </p>
        )}
      </header>
      <div className="border-y border-foreground/20 py-10">{children}</div>
      {footer && (
        <p className="mt-8 text-center text-xs font-light uppercase tracking-[0.2em] text-muted-foreground">
          {footer}
        </p>
      )}
    </div>
  );
}
