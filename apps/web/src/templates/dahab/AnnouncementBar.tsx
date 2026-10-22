'use client';

import Link from 'next/link';
import { sanitizeUrl } from '@ebda/shared';
import type { AnnouncementBarProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { ChevronIcon } from './ui';

/** One quiet line above the header. Merchant colours win when set. */
export default function DahabAnnouncementBar({
  text,
  textAr,
  link,
  linkText,
  linkTextAr,
  bgColor,
  textColor,
  isRtl: isRtlProp,
  urlPrefix,
}: AnnouncementBarProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const message = (isRtl && textAr ? textAr : text) || '';
  if (!message) return null;
  const cta = isRtl && linkTextAr ? linkTextAr : linkText;
  const safe = link ? sanitizeUrl(link) : '';
  const href = safe && urlPrefix && safe.startsWith('/') ? `${urlPrefix}${safe}` : safe;

  return (
    <div
      className="border-b border-border/60 bg-[hsl(var(--bg-section-alt))] px-4 text-center text-[13px] text-primary"
      style={{
        ...(bgColor ? { backgroundColor: bgColor } : {}),
        ...(textColor ? { color: textColor } : {}),
      }}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {href ? (
        <Link
          href={href}
          className="inline-flex min-h-[38px] items-center gap-2 hover:underline hover:underline-offset-4"
        >
          <span>{message}</span>
          {cta && <span className="underline underline-offset-4">{cta}</span>}
          <ChevronIcon className="h-3 w-3" />
        </Link>
      ) : (
        <p className="flex min-h-[38px] items-center justify-center">{message}</p>
      )}
    </div>
  );
}
