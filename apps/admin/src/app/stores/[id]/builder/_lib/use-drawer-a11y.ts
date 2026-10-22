'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Below `lg` the start / end panes are drawers over the canvas: while one is open it traps Tab,
 * closes on Esc and gives focus back to what opened it. From `lg` up the panes are ordinary
 * columns and this does nothing.
 */
export function useDrawerA11y(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    const items = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    (items()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      // Give focus back to what opened the drawer, unless it already went somewhere on purpose
      // (a tree row handing focus to the canvas).
      const now = document.activeElement;
      const lost = !now || now === document.body || el.contains(now);
      if (lost && opener && opener.isConnected) opener.focus();
    };
  }, [open, ref]);
}
