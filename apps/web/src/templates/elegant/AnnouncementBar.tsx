'use client';

import Link from 'next/link';
import { sanitizeUrl } from '@force/shared';
import type { AnnouncementBarProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ElegantAnnouncementBar({
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
    <span className="text-[10px] tracking-[0.3em] uppercase font-extralight text-foreground/70">
      {displayText}
    </span>
  );

  return (
    <div
      className="bg-background border-b border-foreground/10 py-2.5 px-4 text-center"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {link ? (
        <Link
          href={sanitizeUrl(link)}
          className="hover:opacity-70 transition-opacity inline-flex items-center gap-3"
        >
          {content}
          <svg
            className={`w-3 h-3 ${isRtl ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      ) : (
        content
      )}
    </div>
  );
}
