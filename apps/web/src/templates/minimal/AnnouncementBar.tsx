'use client';

import Link from 'next/link';
import type { AnnouncementBarProps } from '../types';

export default function MinimalAnnouncementBar({
  text,
  textAr,
  link,
  isRtl = false,
}: AnnouncementBarProps) {
  const displayText = isRtl && textAr ? textAr : text;

  if (!displayText) return null;

  const content = <span className="text-xs tracking-[0.15em] uppercase">{displayText}</span>;

  return (
    <div
      className="bg-foreground text-background py-2 px-4 text-center"
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
