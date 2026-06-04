'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { CartTableProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * Elegant template — cart rendered with thin hairline dividers, generous
 * whitespace, and serif-friendly tracking to match Elegant's fashion-
 * forward aesthetic.
 */
export default function ElegantCartTable({
  items,
  isRtl: isRtlProp,
  currency = 'KWD',
  urlPrefix = '',
  onUpdateQuantity,
  onRemove,
  typography,
}: CartTableProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const format = (price: number) => `${(price / 1000).toFixed(3)} ${currency}`;

  return (
    <div className="divide-y divide-border/50" dir={isRtl ? 'rtl' : 'ltr'}>
      {items.map(item => {
        const displayName = isRtl && item.nameAr ? item.nameAr : item.name;
        return (
          <div key={item.id} className="flex gap-6 py-8">
            <Link
              href={`${urlPrefix}/products/${item.slug}`}
              className="aspect-[3/4] w-24 flex-shrink-0 overflow-hidden bg-muted/30 sm:w-28"
            >
              {item.image ? (
                <Image
                  src={item.image}
                  alt={displayName}
                  width={112}
                  height={150}
                  sizes="112px"
                  className="h-full w-full object-cover"
                />
              ) : null}
            </Link>
            <div className="flex flex-1 flex-col justify-between gap-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Link
                    href={`${urlPrefix}/products/${item.slug}`}
                    className="text-base font-light tracking-wide text-foreground hover:text-primary"
                    style={typography?.name}
                  >
                    {displayName}
                  </Link>
                  <p
                    className="mt-2 text-xs uppercase tracking-[0.2em] text-muted-foreground tabular-nums"
                    style={typography?.price}
                  >
                    {format(item.price)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove?.(item.id)}
                  className="inline-flex min-h-[44px] items-center text-sm uppercase tracking-[0.2em] text-muted-foreground hover:text-destructive underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 cursor-pointer"
                  aria-label={isRtl ? 'إزالة' : 'Remove'}
                  style={typography?.cta}
                >
                  {isRtl ? 'إزالة' : 'Remove'}
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 text-sm">
                  <button
                    type="button"
                    disabled={item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="inline-flex h-11 w-11 items-center justify-center text-lg text-muted-foreground hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 cursor-pointer"
                    aria-label={isRtl ? 'تقليل' : 'Decrease'}
                  >
                    −
                  </button>
                  <span
                    className="min-w-[2ch] text-center font-light tracking-wide"
                    style={typography?.cta}
                  >
                    {item.quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="inline-flex h-11 w-11 items-center justify-center text-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 cursor-pointer"
                    aria-label={isRtl ? 'زيادة' : 'Increase'}
                  >
                    +
                  </button>
                </div>
                <p
                  className="text-sm font-light tracking-wide text-foreground tabular-nums"
                  style={typography?.price}
                >
                  {format(item.price * item.quantity)}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
