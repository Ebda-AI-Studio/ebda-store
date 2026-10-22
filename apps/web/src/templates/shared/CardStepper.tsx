'use client';

import { useRef, useState } from 'react';
import { cn, useToast } from '@ebda/ui';
import { useCart, type CartItem } from '../../contexts/CartContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { cartRemovalToast } from '../../app/cart/cart-removal';
import { MinusIcon, PlusIcon } from './icons';

/**
 * - qty + in place of the add control (state of the one CTA, not a second CTA). Targets 44px.
 * `-` at 1 removes the line and offers Undo, exactly like the cart page. A refused `+` (the
 * product's stock or the cart cap, enforced by the server) restores the quantity and says so
 * once, in words; the `+` stays disabled until the quantity changes.
 */
export function CardStepper({ line, className }: { line: CartItem; className?: string }) {
  const cart = useCart();
  const { addToast } = useToast();
  const { t, isRtl } = useLanguage();
  const [capped, setCapped] = useState<number | null>(null);
  const busy = useRef(false);
  const atCap = capped !== null && capped === line.quantity;

  const change = async (next: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (next <= 0) {
        await cart.removeItem(line.id);
        addToast(cartRemovalToast(line, { isRtl, t, addItem: cart.addItem }));
      } else {
        await cart.updateQuantity(line.id, next);
        setCapped(null);
      }
    } catch {
      if (next > line.quantity) setCapped(line.quantity);
    } finally {
      busy.current = false;
    }
  };

  const name = (isRtl ? line.nameAr : undefined) ?? line.name;
  return (
    <div
      role="group"
      aria-label={t(`Quantity of ${name}`, `كمية ${name}`)}
      data-cta="stepper"
      className={cn(
        'mt-auto inline-flex min-h-[44px] w-full items-center justify-between rounded-[var(--radius)] border border-primary bg-background text-foreground',
        className
      )}
    >
      <button
        type="button"
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          void change(line.quantity - 1);
        }}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] text-primary"
        aria-label={t('Decrease quantity', 'إنقاص الكمية')}
      >
        <MinusIcon className="h-4 w-4" />
      </button>
      <span
        role="status"
        aria-live="polite"
        className="min-w-8 text-center text-sm font-semibold tabular-nums"
      >
        {line.quantity}
        {atCap && (
          <span className="sr-only">
            {t('Maximum quantity reached', 'وصلت للحد الأقصى للكمية')}
          </span>
        )}
      </span>
      <button
        type="button"
        disabled={atCap}
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          void change(line.quantity + 1);
        }}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] text-primary disabled:opacity-40"
        aria-label={t('Increase quantity', 'زيادة الكمية')}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
