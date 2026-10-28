'use client';

import Link from '../../components/StoreLink';
import { sanitizeUrl } from '@ebda/shared';
import type { AnnouncementBarProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function MinimalAnnouncementBar({
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
    <span className="text-xs tracking-[0.28em] uppercase font-normal text-foreground/80">
      {displayText}
    </span>
  );

  return (
    <div
      className="bg-background border-b border-border py-2 px-4 text-center"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {link ? (
        <Link href={resolvedLink} className="hover:opacity-70 transition-opacity">
          {content}
        </Link>
      ) : (
        content
      )}
    </div>
  );
}
