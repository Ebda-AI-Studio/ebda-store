'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useCurrentUrl } from '../../hooks/useCurrentUrl';

/**
 * PDP share. L-11 (W3): one native share button where the device has a share sheet, else
 * WhatsApp + copy link (was X / Facebook / Telegram / WhatsApp discs + copy under a tracked
 * eyebrow). Sprint 4 (2026-05-17) origin: Observed on all 3 OSOSS references during the
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
  /** The page already carries a WhatsApp "ask or share" button: no second WhatsApp pill here. */
  hasWhatsAppAsk?: boolean;
}

export function ShareProductRow({
  productName,
  url,
  className = '',
  hasWhatsAppAsk = false,
}: ShareProductRowProps) {
  const { isRtl, t } = useLanguage();
  const currentUrl = useCurrentUrl();
  const shareUrl = url ?? currentUrl;
  const [copied, setCopied] = useState(false);

  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(productName);

  const whatsappHref = `https://wa.me/?text=${encodedText}%20${encodedUrl}`;
  const whatsappIcon =
    'M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.945-1.418A9.96 9.96 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm5.07 14.07c-.21.59-1.23 1.13-1.71 1.21-.44.07-1 .1-1.6-.1-.37-.12-.85-.28-1.46-.55-2.57-1.11-4.25-3.7-4.38-3.87-.13-.17-1.04-1.38-1.04-2.64s.66-1.87.89-2.13c.23-.26.51-.32.68-.32.17 0 .34 0 .49.01.16.01.37-.06.58.44.21.51.72 1.77.78 1.9.06.13.1.28.02.45-.08.17-.12.27-.24.42-.12.15-.25.33-.36.44-.12.12-.24.25-.1.49.13.24.6.99 1.29 1.6.89.79 1.64 1.04 1.88 1.16.24.12.38.1.52-.06.14-.16.6-.7.76-.94.16-.24.32-.2.54-.12.22.08 1.4.66 1.64.78.24.12.4.18.46.28.05.1.05.59-.16 1.18z';

  // L-11 (W3): a device with a share sheet gets ONE button. Read after mount, so the server markup
  // (no navigator) and the first client render agree; the fallback is WhatsApp + Copy link.
  const [canNativeShare, setCanNativeShare] = useState(false);
  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  async function handleNativeShare() {
    try {
      await navigator.share({ title: productName, url: shareUrl });
    } catch {
      // The shopper closed the sheet: nothing to do.
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Old browsers fall back to a textarea trick — skip for simplicity.
    }
  }

  const pill =
    "relative before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] inline-flex h-11 items-center justify-center gap-1.5 rounded-[var(--radius)] border border-input px-3 text-sm text-foreground hover:bg-foreground/5 transition-colors";

  if (canNativeShare) {
    return (
      <div className={`flex items-center ${className}`} dir={isRtl ? 'rtl' : 'ltr'}>
        <button type="button" onClick={handleNativeShare} className={pill}>
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 3v12m0-12 4 4m-4-4-4 4M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"
            />
          </svg>
          {t('Share', 'مشاركة')}
        </button>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`} dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-2">
        {!hasWhatsAppAsk && (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('Share on WhatsApp', 'مشاركة على واتساب')}
            className={pill}
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d={whatsappIcon} />
            </svg>
            {t('WhatsApp', 'واتساب')}
          </a>
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={t('Copy link', 'نسخ الرابط')}
          // Touch hitbox: visual height stays 36px; before:-inset-y-2 grows
          // the vertical tap target to ~44px without changing rendered size.
          className={pill}
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
              {isRtl ? 'اتنسخ' : 'Copied'}
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
