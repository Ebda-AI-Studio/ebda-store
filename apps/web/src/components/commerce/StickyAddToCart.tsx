'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { useAnchorOffscreen } from './useAnchorOffscreen';
import { useStickyBarHeight } from './useStickyBarHeight';

/**
 * Phone-only add-to-cart bar, shown from first paint whenever the main
 * add-to-cart row is out of view, below the fold or scrolled past (B0-49), so the
 * action is always reachable. It owns NO add logic: `onAdd` and `disabled` are the page's own handler
 * and the page's single `addDisabled` value (required personalisation lives in
 * that value), so there is never a second add path.
 *
 * Fixed-bottom recipe (UI rule 6) + C-04: while it shows it REPLACES the BottomTabBar
 * (`useStickyBarHeight` marks `<html data-task-bar>`, globals.css hides the tab bar), so it
 * sits at the bottom edge with the safe-area inset inside its own padding, publishes its
 * height for `scroll-padding-bottom`, and reserves body space via `body[data-sticky-atc]`.
 */
export function StickyAddToCart(p: {
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  price: string;
  label: string;
  disabled?: boolean;
  onAdd: () => void;
}) {
  const show = useAnchorOffscreen(p.anchorRef);
  const barRef = useRef<HTMLDivElement>(null);
  useStickyBarHeight(barRef, show);
  useEffect(() => {
    if (show) document.body.dataset.stickyAtc = '1';
    else delete document.body.dataset.stickyAtc;
    return () => {
      delete document.body.dataset.stickyAtc;
    };
  }, [show]);
  if (!show) return null;
  return (
    <div
      ref={barRef}
      data-testid="sticky-atc"
      className="sticky-bar-in fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{p.title}</p>
          <p className="text-sm font-semibold tabular-nums text-foreground">{p.price}</p>
        </div>
        <button
          type="button"
          disabled={p.disabled}
          onClick={p.onAdd}
          className="h-11 rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {p.label}
        </button>
      </div>
    </div>
  );
}
