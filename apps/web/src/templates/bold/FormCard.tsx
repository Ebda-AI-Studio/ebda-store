'use client';

import type { FormCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function BoldFormCard({
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
      <div className="border-2 border-foreground bg-background">
        <header className="border-b-2 border-foreground bg-foreground px-6 py-4 text-center">
          <h1 className="text-xl font-black uppercase tracking-tight text-background">
            {displayTitle}
          </h1>
          {displaySubtitle && (
            <p className="mt-1 text-xs font-bold uppercase tracking-wider text-background/70">
              {displaySubtitle}
            </p>
          )}
        </header>
        <div className="p-6">{children}</div>
      </div>
      {footer && (
        <p className="mt-4 text-center text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {footer}
        </p>
      )}
    </div>
  );
}
