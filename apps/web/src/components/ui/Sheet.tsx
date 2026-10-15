'use client';

/**
 * Sheet — the ONE storefront primitive for sheets, drawers and modal panels
 * (R-04, quality-bar § 3). Built on the native `<dialog>.showModal()`:
 *
 *  - the page behind is inert (top layer), Escape and a backdrop tap close it;
 *  - focus moves in on open, Tab stays inside, and focus returns to the control
 *    that opened it when it closes (also when it closes by unmounting);
 *  - the page does not scroll behind it (html + body locked, restored exactly);
 *  - the body scrolls on its own with `overscroll-contain`;
 *  - a 44px close button, corners from `var(--radius)`, no decorative drag
 *    handle (a handle that does nothing imitates function — S-04).
 *
 * `side`: `bottom` (phone sheet), `start` / `end` (drawers, mirrored by `dir`),
 * `center` (modal panel). Controlled: the owner holds `open` and closes on
 * `onClose`. Children render only while open, so a closed sheet holds no
 * focusable content.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';

export type SheetSide = 'bottom' | 'start' | 'end' | 'center';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; it also names the dialog. */
  title: ReactNode;
  /** Accessible name of the close button, through t(). */
  closeLabel: string;
  side?: SheetSide;
  children?: ReactNode;
  footer?: ReactNode;
  id?: string;
  dir?: 'rtl' | 'ltr';
  /** Panel surface (background, text colour, width overrides). */
  className?: string;
  style?: CSSProperties;
  headerClassName?: string;
  titleClassName?: string;
  closeClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  /** The `::backdrop` scrim. */
  backdropClassName?: string;
  /** Focus the close button on open instead of the first control in the body
   *  (a sheet that opens on a form control would show a focus ring on it). */
  focusClose?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SIDE_CLASS: Record<SheetSide, string> = {
  bottom:
    'mb-0 mt-auto w-full max-w-full max-h-[85dvh] rounded-t-[var(--radius)] pb-[env(safe-area-inset-bottom)] motion-safe:open:animate-in motion-safe:open:slide-in-from-bottom motion-safe:open:duration-300',
  start:
    'ms-0 me-auto h-full max-h-full w-[min(420px,88vw)] max-w-full motion-safe:open:animate-in motion-safe:open:slide-in-from-left rtl:motion-safe:open:slide-in-from-right motion-safe:open:duration-300',
  end: 'me-0 ms-auto h-full max-h-full w-[min(420px,88vw)] max-w-full motion-safe:open:animate-in motion-safe:open:slide-in-from-right rtl:motion-safe:open:slide-in-from-left motion-safe:open:duration-300',
  center:
    'm-auto w-[calc(100%-2rem)] max-w-lg max-h-[85dvh] rounded-[var(--radius)] motion-safe:open:animate-in motion-safe:open:fade-in motion-safe:open:duration-200',
};

export function Sheet({
  open,
  onClose,
  title,
  closeLabel,
  side = 'bottom',
  children,
  footer,
  id,
  dir,
  className = 'bg-background text-foreground',
  style,
  headerClassName = '',
  titleClassName = 'text-base font-semibold',
  closeClassName = 'text-muted-foreground hover:text-foreground',
  bodyClassName = 'px-5 pb-4',
  footerClassName = 'border-t border-border px-5 py-3',
  backdropClassName = 'backdrop:bg-foreground/40',
  focusClose = false,
}: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const returnTo = useRef<HTMLElement | null>(null);
  const restoreScroll = useRef<(() => void) | null>(null);
  // Latest onClose without re-running the open/close effect when it changes identity.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const settle = useCallback(() => {
    restoreScroll.current?.();
    restoreScroll.current = null;
    const back = returnTo.current;
    returnTo.current = null;
    if (back && back.isConnected) back.focus?.();
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = (document.activeElement as HTMLElement | null) ?? null;
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      const { documentElement: html, body } = document;
      const prev = [html.style.overflow, body.style.overflow];
      html.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
      restoreScroll.current = () => {
        html.style.overflow = prev[0];
        body.style.overflow = prev[1];
      };
      // First control inside the body (else the close button), after children mount.
      const first =
        d.querySelector<HTMLElement>('[data-autofocus]') ??
        d.querySelector<HTMLElement>(`[data-sheet-body] :is(${FOCUSABLE})`) ??
        d.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    } else if (!open) {
      if (d.open) {
        if (typeof d.close === 'function') d.close();
        else d.removeAttribute('open');
      }
      // Idempotent: also settles a dialog the BROWSER already closed.
      settle();
    }
  }, [open, settle]);

  // The browser can close the dialog itself (Android back / a close watcher
  // that makes `cancel` non-cancelable, a future `<form method="dialog">`):
  // its `close` event unlocks the page, gives focus back and tells the owner,
  // even when the owner never unmounts it (the cookie modal).
  const openRef = useRef(open);
  openRef.current = open;
  const onNativeClose = () => {
    // A `close` queued by an owner close that was followed by a re-open before the
    // event fired: the dialog is open again, so this event is stale — ignore it
    // (settling now would unlock the page under the re-opened sheet).
    if (ref.current?.open) return;
    settle();
    if (openRef.current) onCloseRef.current();
  };

  // Unmounted while open (route change, owner gone): unlock and give focus back.
  useEffect(() => () => settle(), [settle]);

  const requestClose = () => onCloseRef.current();

  // Native Escape fires `cancel`; keep the owner in control of `open`.
  const onCancel = (e: SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    requestClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === e.currentTarget)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // A click on the dialog box itself (not its content) is a click on the backdrop.
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) requestClose();
  };

  return (
    <dialog
      ref={ref}
      id={id}
      dir={dir}
      aria-labelledby={titleId}
      onCancel={onCancel}
      onClose={onNativeClose}
      onKeyDown={onKeyDown}
      onClick={onClick}
      data-sheet={side}
      style={style}
      className={`fixed inset-0 overflow-hidden border-0 p-0 shadow-2xl open:flex open:flex-col motion-reduce:animate-none ${SIDE_CLASS[side]} ${backdropClassName} ${className}`}
    >
      {open && (
        <>
          <div
            className={`flex shrink-0 items-center justify-between gap-3 ps-5 pe-2 pt-2 ${headerClassName}`}
          >
            <h2 id={titleId} className={titleClassName}>
              {title}
            </h2>
            <button
              type="button"
              onClick={requestClose}
              aria-label={closeLabel}
              data-sheet-close
              data-autofocus={focusClose ? '' : undefined}
              className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${closeClassName}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div
            data-sheet-body
            className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${bodyClassName}`}
          >
            {children}
          </div>
          {footer && <div className={`shrink-0 ${footerClassName}`}>{footer}</div>}
        </>
      )}
    </dialog>
  );
}
