'use client';

import { useEffect, useRef, type RefObject } from 'react';
import Link from '../StoreLink';
import { CartIcon } from '@ebda/ui';
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
  /**
   * The cart link the BottomTabBar carried. The bar replaces the tab bar while it
   * shows (C-04), and on most skins the tab bar is the only phone cart entry, so
   * the bar keeps one (W1a fix round). Omitted = no link (tests, embeds).
   */
  cartHref?: string;
  cartCount?: number;
  /** `cartCount` in the store's numerals. */
  cartCountText?: string;
  cartLabel?: string;
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
        {p.cartHref && (
          <Link
            href={p.cartHref}
            aria-label={p.cartLabel}
            data-testid="sticky-atc-cart"
            className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] border border-input text-foreground"
          >
            <CartIcon className="h-5 w-5" aria-hidden="true" />
            {(p.cartCount ?? 0) > 0 && (
              <span className="absolute -end-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold leading-none text-primary-foreground tabular-nums">
                {p.cartCountText ?? p.cartCount}
              </span>
            )}
          </Link>
        )}
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
