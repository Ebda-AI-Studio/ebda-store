'use client';

import { useEffect, type RefObject } from 'react';
import { useInView } from './useInView';

/**
 * Phone-only add-to-cart bar, shown while the main add-to-cart row is out of
 * view. It owns NO add logic: `onAdd` and `disabled` are the page's own handler
 * and the page's single `addDisabled` value (required personalisation lives in
 * that value), so there is never a second add path.
 *
 * Fixed-bottom recipe (UI rule 6): lifted above the 56px BottomTabBar with the
 * same `bottom-[calc(56px+env(safe-area-inset-bottom))]` the cookie banner uses,
 * and it reserves body space via `body[data-sticky-atc]` (globals.css).
 */
export function StickyAddToCart(p: {
  anchorRef: RefObject<HTMLElement | null>;
  title: string;
  price: string;
  label: string;
  disabled?: boolean;
  onAdd: () => void;
}) {
  const show = !useInView(p.anchorRef);
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
      data-testid="sticky-atc"
      className="sticky-bar-in fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-40 border-t border-border bg-background px-4 py-2 md:hidden"
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
