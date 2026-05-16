'use client';

import type { FormCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ClassicFormCard({
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
      <header className="mb-8 text-center">
        <h1 className="text-2xl font-serif font-normal tracking-tight text-foreground">
          {displayTitle}
        </h1>
        {displaySubtitle && (
          <p className="mt-3 text-xs uppercase tracking-widest text-muted-foreground">
            {displaySubtitle}
          </p>
        )}
      </header>
      <div className="border border-border bg-background p-8">{children}</div>
      {footer && (
        <p className="mt-6 text-center text-xs uppercase tracking-widest text-muted-foreground">
          {footer}
        </p>
      )}
    </div>
  );
}
