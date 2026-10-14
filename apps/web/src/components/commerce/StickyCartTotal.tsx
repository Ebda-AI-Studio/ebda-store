'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * Phone-only total + checkout bar for the cart page. `totalLabel` + `total` are one of the
 * summary's own rows, verbatim (label, value and money format), so the always-visible bar can
 * never quote a second price for the same cart (F1). Always shown when the cart
 * has items (no IntersectionObserver). `disabled` carries the cart's own
 * checkoutBlocked value (minimum order / unavailable lines) and `blockedMessage`
 * its message, so there is no second rule. Lifted above the 56px BottomTabBar
 * (UI rule 6) and reserves body space via `body[data-sticky-cart]`.
 */
export function StickyCartTotal(p: {
  /** The summary row the bar repeats ("Subtotal" while shipping is calculated at checkout). */
  totalLabel: string;
  total: string;
  itemCount: number;
  itemCountLabel: string;
  href: string;
  label: string;
  disabled?: boolean;
  blockedMessage?: string;
}) {
  const show = p.itemCount > 0;
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
  if (!show) return null;
  return (
    <div
      data-testid="sticky-cart-total"
      className="sticky-bar-in fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-40 border-t border-border bg-background px-4 py-2 md:hidden"
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
