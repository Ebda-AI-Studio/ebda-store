'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { CartTableProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';

/**
 * Modern template — cart item list. Each row is a card with the product
 * image, name, quantity controls, and remove button, using the same
 * rounded/bordered aesthetic as Modern's ProductCard.
 */
export default function ModernCartTable({
  items,
  isRtl: isRtlProp,
  currency = 'KWD',
  urlPrefix = '',
  onUpdateQuantity,
  onRemove,
  typography,
}: CartTableProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;

  const format = (price: number) => `${localize((price / 1000).toFixed(3))} ${currency}`;

  return (
    <div className="space-y-3" dir={isRtl ? 'rtl' : 'ltr'}>
      {items.map(item => {
        const displayName = isRtl && item.nameAr ? item.nameAr : item.name;
        const lineTotal = item.price * item.quantity;
        return (
          <div
            key={item.id}
            className="flex gap-4 rounded-xl border border-border/60 bg-card p-4 transition-shadow hover:shadow-md sm:p-5"
          >
            <Link
              href={`${urlPrefix}/products/${item.slug}`}
              className="h-24 w-24 flex-shrink-0 overflow-hidden rounded-lg bg-muted sm:h-28 sm:w-28"
            >
              {item.image ? (
                <Image
                  src={item.image}
                  alt={displayName}
                  width={112}
                  height={112}
                  className="h-full w-full object-cover"
                  sizes="(max-width: 640px) 96px, 112px"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                    />
                  </svg>
                </div>
              )}
            </Link>

            <div className="flex flex-1 flex-col justify-between gap-2">
              <div>
                <Link
                  href={`${urlPrefix}/products/${item.slug}`}
                  className="line-clamp-2 font-semibold text-foreground hover:text-primary transition-colors"
                  style={typography?.name}
                >
                  {displayName}
                </Link>
                {(item.variantTitle || item.variantTitleAr) && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {isRtl && item.variantTitleAr ? item.variantTitleAr : item.variantTitle}
                  </p>
                )}
                <p
                  className="mt-1 text-sm font-medium text-primary tabular-nums"
                  style={typography?.price}
                >
                  {format(item.price)}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 rounded-lg border border-border/60 p-1">
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                    disabled={item.quantity <= 1}
                    aria-label={isRtl ? 'تقليل الكمية' : 'Decrease quantity'}
                    style={typography?.cta}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M20 12H4"
                      />
                    </svg>
                  </button>
                  <span
                    className="min-w-[2ch] text-center text-sm font-semibold"
                    style={typography?.cta}
                  >
                    {localize(item.quantity)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                    aria-label={isRtl ? 'زيادة الكمية' : 'Increase quantity'}
                    style={typography?.cta}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </button>
                </div>

                <div className="flex items-center gap-4">
                  <p
                    className="text-sm font-bold text-foreground sm:text-base tabular-nums"
                    style={typography?.price}
                  >
                    {format(lineTotal)}
                  </p>
                  <button
                    type="button"
                    onClick={() => onRemove?.(item.id)}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1"
                    aria-label={isRtl ? 'إزالة' : 'Remove'}
                    style={typography?.cta}
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
