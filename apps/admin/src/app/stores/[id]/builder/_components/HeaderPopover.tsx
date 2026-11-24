'use client';

/**
 * The one popover the editor header uses (page menu, product combobox, publish confirm, overflow
 * menu). A trigger button plus an absolutely placed panel anchored on the trigger's inline-start
 * (or inline-end) edge, so it mirrors in Arabic with logical properties only. Closes on an outside
 * press, Escape (focus returns to the trigger) and Tab leaving the panel.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

interface HeaderPopoverApi {
  open: boolean;
  close: () => void;
  triggerProps: {
    ref: React.RefObject<HTMLButtonElement>;
    'aria-haspopup': 'menu' | 'listbox' | 'dialog';
    'aria-expanded': boolean;
    'aria-controls': string | undefined;
    onClick: () => void;
  };
}

export function HeaderPopover({
  haspopup,
  align = 'start',
  panelClassName = '',
  panelRole,
  panelLabel,
  trigger,
  children,
}: {
  haspopup: 'menu' | 'listbox' | 'dialog';
  align?: 'start' | 'end';
  panelClassName?: string;
  panelRole?: string;
  panelLabel?: string;
  trigger: (api: HeaderPopoverApi) => ReactNode;
  children: (api: { close: () => void }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null) as React.RefObject<HTMLButtonElement>;
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'Tab') {
      // Tab out of the panel closes it; the browser moves focus on.
      const panel = rootRef.current?.querySelector('[data-popover-panel]');
      if (panel && !e.shiftKey) {
        const focusable = panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input,[tabindex="0"]'
        );
        if (focusable[focusable.length - 1] === document.activeElement) setOpen(false);
      }
    }
  };

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="relative">
      {trigger({
        open,
        close,
        triggerProps: {
          ref: triggerRef,
          'aria-haspopup': haspopup,
          'aria-expanded': open,
          'aria-controls': open ? panelId : undefined,
          onClick: () => setOpen(o => !o),
        },
      })}
      {open && (
        <div
          id={panelId}
          data-popover-panel
          role={panelRole}
          aria-label={panelLabel}
          className={`editor-motion-pop absolute top-full z-50 mt-1 min-w-48 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md ${
            align === 'end' ? 'end-0' : 'start-0'
          } ${panelClassName}`}
        >
          {children({ close })}
        </div>
      )}
    </div>
  );
}
