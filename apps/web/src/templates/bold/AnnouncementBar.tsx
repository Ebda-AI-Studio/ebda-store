'use client';

import Link from 'next/link';
import { sanitizeUrl } from '@ebda/shared';
import type { AnnouncementBarProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function BoldAnnouncementBar({
  text,
  textAr,
  link,
  isRtl: isRtlProp,
  urlPrefix,
}: AnnouncementBarProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayText = isRtl && textAr ? textAr : text;

  if (!displayText) return null;

  // Store-slug prefix on relative internal links only — see urlPrefix doc
  // on HeroBannerProps.
  const safeLink = sanitizeUrl(link);
  const resolvedLink = urlPrefix && safeLink.startsWith('/') ? `${urlPrefix}${safeLink}` : safeLink;

  const content = (
    <div className="flex items-center justify-center gap-2 sm:gap-3 text-sm sm:text-base">
      <span className="text-base sm:text-xl shrink-0">🔥</span>
      <span className="font-black tracking-wide text-center">{displayText}</span>
      {link && (
        <span className="inline-flex items-center gap-1 font-black shrink-0">
          {isRtl ? '←' : '→'}
        </span>
      )}
    </div>
  );

  return (
    <div className="bg-primary text-primary-foreground py-3 px-4" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto">
        {link ? (
          <Link href={resolvedLink} className="block hover:opacity-80 transition-opacity">
            {content}
          </Link>
        ) : (
          content
        )}
      </div>
    </div>
  );
}
