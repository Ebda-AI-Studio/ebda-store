'use client';

import type { FormCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function DahabFormCard({
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
  const heading = isRtl ? (titleAr ?? title) : (title ?? titleAr);
  const sub = isRtl ? (subtitleAr ?? subtitle) : (subtitle ?? subtitleAr);
  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="w-full max-w-md">
      <header className="mb-8 text-center">
        <h1 className="font-display text-3xl text-foreground rtl:text-[2rem]">{heading}</h1>
        {sub && <p className="mt-3 text-sm text-muted-foreground">{sub}</p>}
      </header>
      <div className="rounded-[var(--radius)] border border-border bg-card p-6 sm:p-8">
        {children}
      </div>
      {footer && <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>}
    </div>
  );
}
