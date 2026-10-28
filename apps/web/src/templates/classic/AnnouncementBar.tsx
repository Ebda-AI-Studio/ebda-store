'use client';

import Link from '../../components/StoreLink';
import { sanitizeUrl } from '@ebda/shared';
import type { AnnouncementBarProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ClassicAnnouncementBar({
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
    <div className="flex items-center justify-center gap-3 text-sm font-serif">
      {/* Decorative dash */}
      <span className="hidden sm:inline text-current/50">—</span>

      <span className="tracking-widest font-serif">{displayText}</span>

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
