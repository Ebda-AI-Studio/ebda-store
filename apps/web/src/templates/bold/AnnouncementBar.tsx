'use client';

import Link from 'next/link';
import type { AnnouncementBarProps } from '../types';

export default function BoldAnnouncementBar({
  text,
  textAr,
  link,
  isRtl = false,
}: AnnouncementBarProps) {
  const displayText = isRtl && textAr ? textAr : text;

  if (!displayText) return null;

  const content = (
    <div className="flex items-center justify-center gap-3">
      <span className="text-xl">🔥</span>
      <span className="font-black tracking-wide">{displayText}</span>
      {link && <span className="inline-flex items-center gap-1 font-black">→</span>}
    </div>
  );

  return (
    <div className="bg-primary text-primary-foreground py-3 px-4" dir={isRtl ? 'rtl' : 'ltr'}>
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
