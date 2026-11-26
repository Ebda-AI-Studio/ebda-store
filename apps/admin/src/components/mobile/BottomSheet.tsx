'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, type ReactNode } from 'react';
import { useT } from '@/i18n/useT';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** When true, the sheet wraps content at any viewport (mobile-first
   *  modal). When false (default), it slides up from the bottom on
   *  `< md` screens but renders as a centred dialog at `md+`. */
  fullSheet?: boolean;
  children: ReactNode;
  /** Optional sticky footer for primary actions. The footer survives
   *  body scrolling so a long form's Save button is always reachable
   *  with the thumb. */
  footer?: ReactNode;
  /** Maximum height the sheet may consume on mobile. Defaults to 90vh
   *  so the merchant can still see what's behind it. */
  maxHeightVh?: number;
}

/**
 * Mobile-first modal primitive. On phones (`< md`) it slides up from the
 * bottom edge with a drag handle and a sticky header; on tablet and up
 * (`md+`) it falls back to a centred dialog matching the legacy
 * `fixed inset-0 ... flex items-center justify-center` pattern.
 *
 * Replaces the ad-hoc backdrop+card construct that ~15 admin modals
 * still ship inline. Use this for any merchant-input modal —
 * coupons / shipping zones / tax rates / variant edits / store
 * suspension confirmations / etc.
 *
 * Body-scroll lock + Escape-to-close are handled here so callers can
 * focus on the form contents alone.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  fullSheet = false,
  children,
  footer,
  maxHeightVh = 90,
}: BottomSheetProps) {
  const t = useT('components.bottomSheet');

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const desktopWrapperClass = fullSheet ? 'sm:items-end' : 'sm:items-center';
  const desktopSheetClass = fullSheet ? 'sm:rounded-t-lg' : 'sm:max-w-lg sm:rounded-lg';

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end justify-center bg-black/50 ${desktopWrapperClass}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`relative flex w-full flex-col rounded-t-lg bg-card shadow-xl ${desktopSheetClass}`}
        style={{ maxHeight: `${maxHeightVh}vh` }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drag handle — visual only on mobile. The whole header is
            tappable so a customer can dismiss without aiming. */}
        <button
          data-ui="handle"
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-muted-foreground/30 sm:hidden"
        />

        {title && (
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="-me-2 justify-center text-muted-foreground"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && <div className="border-t border-border bg-card px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
