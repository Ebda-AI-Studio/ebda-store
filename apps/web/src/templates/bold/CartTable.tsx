'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { CartTableProps } from '../types';
import { CartLineUnavailableNotice } from '../shared/CartLineUnavailable';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';

import { minorToDecimalString, REGION } from '@force/shared';
/**
 * Bold template — cart as heavy-blocked rows with strong borders,
 * uppercase labels, and sharp contrast. Matches Bold's ProductCard +
 * Header language (gray-950 blocks, solid buttons).
 */
export default function BoldCartTable({
  items,
  isRtl: isRtlProp,
  currency = REGION.currency,
  urlPrefix = '',
  onUpdateQuantity,
  onRemove,
  typography,
}: CartTableProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const format = (price: number) => `${localize(minorToDecimalString(price))} ${currency}`;

  return (
    <div className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      {items.map(item => {
        const displayName = isRtl && item.nameAr ? item.nameAr : item.name;
        return (
          <div key={item.id} className="flex gap-4 border-2 border-foreground bg-background p-4">
            <Link
              href={`${urlPrefix}/products/${item.slug}`}
              className="h-28 w-28 flex-shrink-0 overflow-hidden bg-muted sm:h-32 sm:w-32"
            >
              {item.image ? (
                <Image
                  src={item.image}
                  alt={displayName}
                  width={128}
                  height={128}
                  sizes="128px"
                  className="h-full w-full object-cover"
                />
              ) : null}
            </Link>
            <div className="flex flex-1 flex-col justify-between gap-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link
                    href={`${urlPrefix}/products/${item.slug}`}
                    className="font-black uppercase tracking-tight text-foreground hover:text-primary line-clamp-2"
                    style={typography?.name}
                  >
                    {displayName}
                  </Link>
                  {(item.variantTitle || item.variantTitleAr) && (
                    <p className="mt-0.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      {isRtl && item.variantTitleAr ? item.variantTitleAr : item.variantTitle}
                    </p>
                  )}
                  {item.unavailable && <CartLineUnavailableNotice />}
                  <p
                    className="mt-1 text-sm font-bold uppercase tracking-wider text-primary tabular-nums"
                    style={typography?.price}
                  >
                    {format(item.price)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove?.(item.id)}
                  className="h-11 w-11 flex-shrink-0 border-2 border-foreground bg-background text-2xl font-black text-foreground hover:bg-destructive hover:text-destructive-foreground hover:border-destructive transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 cursor-pointer"
                  aria-label={isRtl ? 'إزالة' : 'Remove'}
                  style={typography?.cta}
                >
                  ×
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center border-2 border-foreground">
                  <button
                    type="button"
                    disabled={item.unavailable || item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="h-11 w-11 font-black text-foreground hover:bg-foreground hover:text-background disabled:opacity-30 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1 cursor-pointer"
                    aria-label={isRtl ? 'تقليل' : 'Decrease'}
                    style={typography?.cta}
                  >
                    −
                  </button>
                  <span
                    className="border-x-2 border-foreground w-10 text-center text-sm font-black"
                    style={typography?.cta}
                  >
                    {localize(item.quantity)}
                  </span>
                  <button
                    type="button"
                    disabled={item.unavailable}
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="h-11 w-11 font-black text-foreground hover:bg-foreground hover:text-background transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1 cursor-pointer disabled:opacity-40"
                    aria-label={isRtl ? 'زيادة' : 'Increase'}
                    style={typography?.cta}
                  >
                    +
                  </button>
                </div>
                <p
                  className="text-base font-black uppercase tracking-tight text-foreground tabular-nums"
                  style={typography?.price}
                >
                  {item.unavailable ? (
                    <s>{format(item.price * item.quantity)}</s>
                  ) : (
                    format(item.price * item.quantity)
                  )}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
