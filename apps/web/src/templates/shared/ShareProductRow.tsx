'use client';

import { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useCurrentUrl } from '../../hooks/useCurrentUrl';

/**
 * Sprint 4 (2026-05-17): PDP share row — X / Facebook / Telegram /
 * WhatsApp / copy-link. Observed on all 3 OSOSS references during the
 * UI catalog session — Ebda Store PDP had no equivalent before this.
 *
 * Each platform link opens in a new tab via `window.open` so the
 * customer doesn't lose the PDP. Copy-link writes the canonical URL
 * to the clipboard and flashes a "Copied!" toast inline for 2 seconds.
 */

interface ShareProductRowProps {
  productName: string;
  /** Defaults to the current page (read after hydration). */
  url?: string;
  className?: string;
}

export function ShareProductRow({ productName, url, className = '' }: ShareProductRowProps) {
  const { isRtl, t } = useLanguage();
  const currentUrl = useCurrentUrl();
  const shareUrl = url ?? currentUrl;
  const [copied, setCopied] = useState(false);

  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(productName);

  const shareLinks = [
    {
      key: 'whatsapp',
      label: 'WhatsApp',
      href: `https://wa.me/?text=${encodedText}%20${encodedUrl}`,
      iconPath:
        'M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.945-1.418A9.96 9.96 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm5.07 14.07c-.21.59-1.23 1.13-1.71 1.21-.44.07-1 .1-1.6-.1-.37-.12-.85-.28-1.46-.55-2.57-1.11-4.25-3.7-4.38-3.87-.13-.17-1.04-1.38-1.04-2.64s.66-1.87.89-2.13c.23-.26.51-.32.68-.32.17 0 .34 0 .49.01.16.01.37-.06.58.44.21.51.72 1.77.78 1.9.06.13.1.28.02.45-.08.17-.12.27-.24.42-.12.15-.25.33-.36.44-.12.12-.24.25-.1.49.13.24.6.99 1.29 1.6.89.79 1.64 1.04 1.88 1.16.24.12.38.1.52-.06.14-.16.6-.7.76-.94.16-.24.32-.2.54-.12.22.08 1.4.66 1.64.78.24.12.4.18.46.28.05.1.05.59-.16 1.18z',
    },
    {
      key: 'telegram',
      label: 'Telegram',
      href: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
      iconPath:
        'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z',
    },
    {
      key: 'facebook',
      label: 'Facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
      iconPath:
        'M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z',
    },
    {
      key: 'x',
      label: 'X',
      href: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`,
      iconPath:
        'M18.244 2H21.5l-7.55 8.626L23 22h-6.99l-5.476-7.181L4.244 22H1l8.084-9.227L1 2h7.151l4.949 6.566L18.244 2zm-1.225 18.05h1.81L7.05 3.842H5.108l11.911 16.208z',
    },
  ];

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Old browsers fall back to a textarea trick — skip for simplicity.
    }
  }

  return (
    <div className={`flex items-center gap-2 ${className}`} dir={isRtl ? 'rtl' : 'ltr'}>
      <span className="text-xs font-semibold text-foreground/70 uppercase tracking-wider">
        {isRtl ? 'مشاركة' : 'Share'}
      </span>
      <div className="flex items-center gap-1.5">
        {shareLinks.map(s => (
          <a
            key={s.key}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${isRtl ? 'مشاركة على' : 'Share on'} ${s.label}`}
            // Touch hitbox: visual circle stays 36px; before:-inset-2 grows
            // the tap target to ~44px without changing rendered size.
            className="relative before:absolute before:-inset-2 before:content-[''] inline-flex h-9 w-9 items-center justify-center rounded-full bg-foreground/5 hover:bg-foreground/10 text-foreground/80 hover:text-foreground transition-colors"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d={s.iconPath} />
            </svg>
          </a>
        ))}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={t('Copy link', 'نسخ الرابط')}
          // Touch hitbox: visual height stays 36px; before:-inset-y-2 grows
          // the vertical tap target to ~44px without changing rendered size.
          className="relative before:absolute before:-inset-y-2 before:inset-x-0 before:content-[''] inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-foreground/5 hover:bg-foreground/10 text-foreground/80 hover:text-foreground transition-colors px-3 text-xs font-medium"
        >
          {copied ? (
            <>
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              {isRtl ? 'تم النسخ' : 'Copied'}
            </>
          ) : (
            <>
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
              {isRtl ? 'نسخ' : 'Copy'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
