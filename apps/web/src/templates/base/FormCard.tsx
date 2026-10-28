'use client';

import type { FormCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function MinimalFormCard({
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
    <div dir={isRtl ? 'rtl' : 'ltr'} className="w-full max-w-md space-y-8">
      <header>
        <h1 className="text-sm tracking-[0.22em] uppercase font-light text-foreground">
          {displayTitle}
        </h1>
        {displaySubtitle && <p className="mt-2 text-sm text-muted-foreground">{displaySubtitle}</p>}
      </header>
      <div>{children}</div>
      {footer && <p className="text-sm text-muted-foreground">{footer}</p>}
    </div>
  );
}
