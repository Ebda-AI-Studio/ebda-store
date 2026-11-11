'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useRef } from 'react';
import { useT } from '@/i18n/useT';

const FOCUSABLE =
  'button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * The order-alerts ask itself: a centred Ebda-night modal with a gold hairline. Purely presentational (the
 * eligibility rules live in OrderAlertsPromptCard). Esc = later; Tab is trapped; focus returns to the opener.
 */
export function OrderAlertsModal({
  busy = false,
  failed = false,
  onEnable,
  onLater,
}: {
  busy?: boolean;
  failed?: boolean;
  onEnable: () => void;
  onLater: () => void;
}) {
  const t = useT('components.orderAlertsPrompt');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onLater();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="ebda-alerts-backdrop fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[6px]"
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby="order-alerts-prompt-title"
        aria-describedby="order-alerts-prompt-body"
        className="ebda-alerts-card relative !outline-none focus-visible:!ring-0 focus-visible:!ring-offset-0 w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-[20px] border border-[#B08D57]/35 bg-[#16191b] px-7 pb-6 pt-8 text-center shadow-[0_30px_80px_rgba(0,0,0,.45)]"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[200px] bg-[url('/motifs/tess8.svg')] opacity-[.11] [mask-image:linear-gradient(to_bottom,#000,transparent)]"
        />
        <span aria-hidden="true" className="relative mx-auto block h-20 w-20">
          <svg viewBox="0 0 44 44" width="80" height="80" fill="none" strokeLinejoin="round">
            <circle cx="22" cy="22" r="20.5" stroke="#B08D57" strokeOpacity=".35" />
            <path
              d="M37 22L28.5 24.7L32.6 32.6L24.7 28.5L22 37L19.3 28.5L11.4 32.6L15.5 24.7L7 22L15.5 19.3L11.4 11.4L19.3 15.5L22 7L24.7 15.5L32.6 11.4L28.5 19.3Z"
              stroke="#B08D57"
              strokeOpacity=".9"
            />
            <circle cx="22" cy="22" r="8.6" fill="#16191b" />
            <g
              transform="translate(15.5 15.5) scale(.54)"
              stroke="#CBA873"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 01-3.4 0" />
            </g>
          </svg>
        </span>
        <h2
          id="order-alerts-prompt-title"
          className="relative mt-5 text-balance text-[22px] font-bold sm:text-[26px] leading-tight text-[#f1f5f3]"
        >
          {t('title')}
        </h2>
        <p
          id="order-alerts-prompt-body"
          className="relative mx-auto mt-2 max-w-[40ch] text-balance text-[15px] leading-[1.6] text-[#a6b0ac]"
        >
          {t('body')}
        </p>
        <div className="relative mt-6 flex flex-col items-stretch gap-1">
          <Button
            size="lg"
            type="button"
            onClick={onEnable}
            disabled={busy}
            className="w-full justify-center font-semibold"
          >
            {busy ? t('enabling') : t('cta')}
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={onLater}
            className="w-full justify-center text-[#a6b0ac] hover:text-[#f1f5f3]"
          >
            {t('later')}
          </Button>
        </div>
        <p
          role="status"
          aria-live="polite"
          className={failed ? 'relative mt-2 text-sm text-[#a6b0ac]' : 'sr-only'}
        >
          {failed && t('error')}
        </p>
      </div>
    </div>
  );
}
