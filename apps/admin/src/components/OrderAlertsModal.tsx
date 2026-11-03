'use client';

import { useEffect, useRef } from 'react';
import { useT } from '@/i18n/useT';

const MOTION_CSS = `@keyframes ebda-alerts-fade{from{opacity:0}to{opacity:1}}@keyframes ebda-alerts-pop{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:none}}`;

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
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
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
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm motion-safe:animate-[ebda-alerts-fade_220ms_ease-out]"
      onKeyDown={onKeyDown}
    >
      <style>{MOTION_CSS}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-alerts-prompt-title"
        aria-describedby="order-alerts-prompt-body"
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-force-500/40 bg-force-950 p-7 text-center text-force-100 shadow-2xl motion-safe:animate-[ebda-alerts-pop_260ms_cubic-bezier(.2,.8,.2,1)]"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-force-400 to-transparent"
        />
        <span
          aria-hidden="true"
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-force-500/40 text-force-400"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 01-3.4 0" />
          </svg>
        </span>
        <h2
          id="order-alerts-prompt-title"
          className="mt-5 text-balance text-lg font-semibold text-force-50"
        >
          {t('title')}
        </h2>
        <p
          id="order-alerts-prompt-body"
          className="mt-2 text-balance text-sm leading-relaxed text-force-300"
        >
          {t('body')}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            data-autofocus
            onClick={onEnable}
            disabled={busy}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-force-400 px-4 text-sm font-semibold text-force-950 transition-colors hover:bg-force-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-force-300 focus-visible:ring-offset-2 focus-visible:ring-offset-force-950 disabled:opacity-60"
          >
            {busy ? t('enabling') : t('cta')}
          </button>
          <button
            type="button"
            onClick={onLater}
            className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm text-force-300 transition-colors hover:text-force-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-force-300"
          >
            {t('later')}
          </button>
        </div>
        <p
          role="status"
          aria-live="polite"
          className={failed ? 'mt-3 text-sm text-force-300' : 'sr-only'}
        >
          {failed && t('error')}
        </p>
      </div>
    </div>
  );
}
