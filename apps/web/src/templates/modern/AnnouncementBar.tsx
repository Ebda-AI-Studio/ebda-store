'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AnnouncementBarProps } from '../types';

export default function ModernAnnouncementBar({
  text,
  textAr,
  link,
  linkText,
  linkTextAr,
  bgColor,
  textColor,
  dismissible = true,
  isRtl = false,
  onDismiss,
}: AnnouncementBarProps) {
  const [isDismissed, setIsDismissed] = useState(false);

  if (isDismissed) {
    return null;
  }

  const displayText = isRtl && textAr ? textAr : text;
  const displayLinkText = isRtl && linkTextAr ? linkTextAr : linkText;

  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss?.();
  };

  return (
    <div
      className="relative py-2.5 px-4 text-center text-sm"
      style={{
        backgroundColor: bgColor ? `hsl(${bgColor})` : 'hsl(var(--primary))',
        color: textColor ? `hsl(${textColor})` : 'hsl(var(--primary-foreground))',
      }}
    >
      <div className="container mx-auto flex items-center justify-center gap-2">
        <span className="font-medium">{displayText}</span>
        {link && (
          <Link
            href={link}
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:opacity-80 transition-opacity font-semibold"
          >
            {displayLinkText || (isRtl ? 'تسوق الآن' : 'Shop Now')}
            <svg
              className={`w-4 h-4 ${isRtl ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 8l4 4m0 0l-4 4m4-4H3"
              />
            </svg>
          </Link>
        )}
      </div>

      {dismissible && (
        <button
          onClick={handleDismiss}
          className={`absolute top-1/2 -translate-y-1/2 ${isRtl ? 'left-4' : 'right-4'} p-1 rounded-full hover:bg-white/20 transition-colors`}
          aria-label={isRtl ? 'إغلاق' : 'Dismiss'}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
