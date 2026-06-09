'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { sanitizeUrl } from '@force/shared';
import type { AnnouncementBarProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ModernAnnouncementBar({
  text,
  textAr,
  link,
  linkText,
  linkTextAr,
  bgColor,
  textColor,
  dismissible = true,
  isRtl: isRtlProp,
  onDismiss,
}: AnnouncementBarProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isDismissed, setIsDismissed] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [shouldMarquee, setShouldMarquee] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  useEffect(() => {
    if (textRef.current && containerRef.current) {
      const textWidth = textRef.current.scrollWidth;
      const containerWidth = containerRef.current.offsetWidth;
      setShouldMarquee(textWidth > containerWidth * 0.7);
    }
  }, [text, textAr]);

  if (isDismissed) return null;

  const displayText = isRtl && textAr ? textAr : text;
  const displayLinkText = isRtl && linkTextAr ? linkTextAr : linkText;

  const handleDismiss = () => {
    setIsVisible(false);
    setTimeout(() => {
      setIsDismissed(true);
      onDismiss?.();
    }, 300);
  };

  return (
    <div
      className="relative overflow-hidden transition-all duration-300"
      style={{
        maxHeight: isVisible ? '48px' : '0px',
        opacity: isVisible ? 1 : 0,
        backgroundColor: bgColor ? `hsl(${bgColor})` : 'hsl(var(--primary))',
        color: textColor ? `hsl(${textColor})` : 'hsl(var(--primary-foreground))',
      }}
    >
      <div className="py-2 px-4">
        <div ref={containerRef} className="flex items-center justify-center gap-3 overflow-hidden">
          <div
            className={`flex items-center gap-3 ${shouldMarquee ? 'motion-safe:animate-marquee whitespace-nowrap' : ''}`}
          >
            <span ref={textRef} className="text-sm font-medium tracking-wide">
              {displayText}
            </span>
            {link && (
              <Link
                href={sanitizeUrl(link)}
                className="inline-flex items-center gap-1 text-sm font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity shrink-0"
              >
                {displayLinkText || (isRtl ? 'تسوق الآن' : 'Shop Now')}
                <svg
                  className={`w-3.5 h-3.5 ${isRtl ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                    d="M17 8l4 4m0 0l-4 4m4-4H3"
                  />
                </svg>
              </Link>
            )}
          </div>
        </div>
      </div>

      {dismissible && (
        <button
          onClick={handleDismiss}
          className={`absolute top-1/2 -translate-y-1/2 ${isRtl ? 'left-3' : 'right-3'} p-1 rounded-full hover:bg-white/20 transition-colors cursor-pointer`}
          aria-label={isRtl ? 'إغلاق' : 'Dismiss'}
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
