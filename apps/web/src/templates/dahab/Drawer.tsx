'use client';

/**
 * Side drawer used by the Dahab header (menu from the inline START, bag from
 * the inline END — both mirror in Arabic). Modal behaviour: focus moves in on
 * open and back to the trigger on close, Escape and the scrim close it, the
 * page behind is inert and does not scroll. Slide-in is transform-only and
 * instant under reduced motion.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, cx } from './ui';

export function DahabDrawer({
  open,
  onClose,
  side,
  label,
  closeLabel,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  side: 'start' | 'end';
  label: string;
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const main = document.querySelector('main');
    main?.setAttribute('inert', '');
    const t = window.setTimeout(() => {
      panel.current?.querySelector<HTMLElement>('[data-autofocus], a, button, input')?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !panel.current) return;
      const f = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      main?.removeAttribute('inert');
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={cx('fixed inset-0 z-[60]', open ? 'visible' : 'invisible')} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={cx(
          'absolute inset-0 bg-background/70 backdrop-blur-[2px] transition-opacity duration-300 motion-reduce:transition-none',
          open ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx(
          'absolute inset-y-0 flex w-[min(420px,88vw)] flex-col border-border bg-background text-foreground shadow-[0_0_60px_-10px_hsl(var(--background))] transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          side === 'start' ? 'start-0 border-e' : 'end-0 border-s',
          open
            ? 'translate-x-0'
            : side === 'start'
              ? '-translate-x-full rtl:translate-x-full'
              : 'translate-x-full rtl:-translate-x-full'
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-border px-5">
          <p className="font-display text-xl text-foreground">{label}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="-me-2 flex h-11 w-11 items-center justify-center text-foreground/80 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && <div className="border-t border-border p-5">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
