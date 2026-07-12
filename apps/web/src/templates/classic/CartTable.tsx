'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { CartTableProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';

/**
 * Classic template — cart list as a clean, table-style grid. Square
 * corners, thin dividers, formal typography matching Classic's
 * ProductCard language.
 */
export default function ClassicCartTable({
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
    <div
      className="divide-y divide-border border border-border bg-background"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {items.map(item => {
        const displayName = isRtl && item.nameAr ? item.nameAr : item.name;
        return (
          <div key={item.id} className="flex gap-5 p-5">
            <Link
              href={`${urlPrefix}/products/${item.slug}`}
              className="h-28 w-28 flex-shrink-0 overflow-hidden bg-muted border border-border/60"
            >
              {item.image ? (
                <Image
                  src={item.image}
                  alt={displayName}
                  width={112}
                  height={112}
                  sizes="112px"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  —
                </div>
              )}
            </Link>
            <div className="flex flex-1 flex-col justify-between">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Link
                    href={`${urlPrefix}/products/${item.slug}`}
                    className="font-medium text-foreground hover:text-primary tracking-tight"
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
                    className="mt-1 text-sm text-muted-foreground tabular-nums"
                    style={typography?.price}
                  >
                    {format(item.price)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove?.(item.id)}
                  className="inline-flex min-h-[44px] items-center text-base uppercase tracking-widest text-muted-foreground hover:text-destructive transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive cursor-pointer"
                  aria-label={isRtl ? 'إزالة' : 'Remove'}
                  style={typography?.cta}
                >
                  {isRtl ? 'إزالة' : 'Remove'}
                </button>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center border border-border">
                  <button
                    type="button"
                    disabled={item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="h-11 w-11 text-muted-foreground hover:bg-muted disabled:opacity-40 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground cursor-pointer"
                    aria-label={isRtl ? 'تقليل' : 'Decrease'}
                    style={typography?.cta}
                  >
                    −
                  </button>
                  <span className="w-10 text-center text-sm font-medium" style={typography?.cta}>
                    {localize(item.quantity)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="h-11 w-11 text-muted-foreground hover:bg-muted transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground cursor-pointer"
                    aria-label={isRtl ? 'زيادة' : 'Increase'}
                    style={typography?.cta}
                  >
                    +
                  </button>
                </div>
                <p
                  className="text-base font-semibold tracking-tight text-foreground tabular-nums"
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
