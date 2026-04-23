'use client';

import type { FormCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ModernFormCard({
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
    <div dir={isRtl ? 'rtl' : 'ltr'} className="w-full max-w-md space-y-6">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{displayTitle}</h1>
        {displaySubtitle && <p className="mt-2 text-sm text-muted-foreground">{displaySubtitle}</p>}
      </header>
      <div className="rounded-2xl border border-border/60 bg-card p-8 shadow-sm">{children}</div>
      {footer && <p className="text-center text-sm text-muted-foreground">{footer}</p>}
    </div>
  );
}
