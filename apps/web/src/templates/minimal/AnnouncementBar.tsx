'use client';

import Link from 'next/link';
import type { AnnouncementBarProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function MinimalAnnouncementBar({
  text,
  textAr,
  link,
  isRtl: isRtlProp,
}: AnnouncementBarProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayText = isRtl && textAr ? textAr : text;

  if (!displayText) return null;

  const content = (
    <span className="text-[10px] tracking-[0.28em] uppercase font-light text-foreground/80">
      {displayText}
    </span>
  );

  return (
    <div
      className="bg-background border-b border-border py-2 px-4 text-center"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {link ? (
        <Link href={link} className="hover:opacity-70 transition-opacity">
          {content}
        </Link>
      ) : (
        content
      )}
    </div>
  );
}
