'use client';

import Link from 'next/link';
import type { AnnouncementBarProps } from '../types';

export default function ElegantAnnouncementBar({
  text,
  textAr,
  link,
  isRtl = false,
}: AnnouncementBarProps) {
  const displayText = isRtl && textAr ? textAr : text;

  if (!displayText) return null;

  const content = (
    <span className="text-xs tracking-[0.25em] uppercase font-light">{displayText}</span>
  );

  return (
    <div
      className="bg-foreground text-background py-2.5 px-4 text-center"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {link ? (
        <Link
          href={link}
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
