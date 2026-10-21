'use client';

import { useEffect, useRef, type RefObject } from 'react';
import Link from 'next/link';
import { useStickyBarHeight } from './useStickyBarHeight';
import { useAnchorOffscreen } from './useAnchorOffscreen';

/**
 * Phone-only total + checkout bar for the cart page. `totalLabel` + `total` are one of the
 * summary's own rows, verbatim (label, value and money format), so the always-visible bar can
 * never quote a second price for the same cart (F1). With `anchorRef` (the summary block) it
 * shows only once the summary's checkout button (`[data-cta="button"]`, else the block) has left
 * the reachable area, like the PDP buy bar (taste re-audit P2-3: the bar sat over a visible total
 * and covered the coupon field). Without it, it shows whenever the cart has items. `disabled` carries the cart's own
 * checkoutBlocked value (minimum order / unavailable lines) and `blockedMessage`
 * its message, so there is no second rule. C-04: while it shows it REPLACES the BottomTabBar
 * (`useStickyBarHeight` marks `<html data-task-bar>`), sitting at the bottom edge with the
 * safe-area inset in its own padding, and its height feeds `scroll-padding-bottom` so the
 * promo field is never focused under it. Reserves body space via `body[data-sticky-cart]`.
 */
export function StickyCartTotal(p: {
  /** The summary row the bar repeats: its "Total" (after discounts; shipping is added at checkout). */
  totalLabel: string;
  total: string;
  itemCount: number;
  itemCountLabel: string;
  href: string;
  label: string;
  disabled?: boolean;
  blockedMessage?: string;
  /** The cart summary block; the bar waits until its checkout button is out of view. */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  // The anchor is the summary's checkout button when there is one (declared before the
  // observer hook so it is resolved when that hook's effect runs).
  const ctaRef = useRef<Element | null>(null);
  // STOP-2 P2: the summary's own Total row (`[data-cart-total]`). While it is reachable on screen
  // the bar would quote the same price a second time, so it waits until the row has left too.
  // Without such a row (a pack that does not tag one) the CTA rule alone decides.
  const totalRef = useRef<Element | null>(null);
  useEffect(() => {
    const box = p.anchorRef?.current;
    ctaRef.current = box?.querySelector('[data-cta="button"]') ?? box ?? null;
    totalRef.current = box?.querySelector('[data-cart-total]') ?? null;
  }, [p.anchorRef]);
  const offscreen = useAnchorOffscreen(ctaRef);
  const totalOffscreen = useAnchorOffscreen(totalRef);
  const show =
    p.itemCount > 0 && (!p.anchorRef || (offscreen && (totalOffscreen || !totalRef.current)));
  // 'blocked' = the bar also carries the one-line blocked message (~24px taller),
  // so globals.css reserves more body space for it.
  const flag = p.disabled && p.blockedMessage ? 'blocked' : '1';
  useEffect(() => {
    if (!show) return;
    document.body.dataset.stickyCart = flag;
    return () => {
      delete document.body.dataset.stickyCart;
    };
  }, [show, flag]);
  const barRef = useRef<HTMLDivElement>(null);
  useStickyBarHeight(barRef, show);
  if (!show) return null;
  return (
    <div
      ref={barRef}
      data-testid="sticky-cart-total"
      className="sticky-bar-in fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden"
    >
      {p.disabled && p.blockedMessage && (
        <p className="mb-1.5 text-xs text-muted-foreground">{p.blockedMessage}</p>
      )}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">
            {p.totalLabel} · {p.itemCountLabel}
          </p>
          <p
            data-testid="sticky-cart-total-value"
            className="text-sm font-semibold tabular-nums text-foreground"
          >
            {p.total}
          </p>
        </div>
        {p.disabled ? (
          <button
            type="button"
            disabled
            className="h-11 rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {p.label}
          </button>
        ) : (
          <Link
            href={p.href}
            className="inline-flex h-11 items-center rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground"
          >
            {p.label}
          </Link>
        )}
      </div>
    </div>
  );
}
