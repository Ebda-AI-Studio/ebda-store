'use client';

import Link from 'next/link';
import type { AnnouncementBarProps } from '../types';

export default function ClassicAnnouncementBar({
  text,
  textAr,
  link,
  isRtl = false,
}: AnnouncementBarProps) {
  const displayText = isRtl && textAr ? textAr : text;

  if (!displayText) return null;

  const content = (
    <div className="flex items-center justify-center gap-3 text-sm">
      {/* Decorative dash */}
      <span className="hidden sm:inline text-current/50">—</span>

      <span className="tracking-wide">{displayText}</span>

      {link && (
        <svg
          className={`w-4 h-4 ${isRtl ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M17 8l4 4m0 0l-4 4m4-4H3"
          />
        </svg>
      )}

      {/* Decorative dash */}
      <span className="hidden sm:inline text-current/50">—</span>
    </div>
  );

  return (
    <div className="bg-foreground text-background py-3 px-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto">
        {link ? (
          <Link href={link} className="block hover:opacity-80 transition-opacity">
            {content}
          </Link>
        ) : (
          content
        )}
      </div>
    </div>
  );
}
