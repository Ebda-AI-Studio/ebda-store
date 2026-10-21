'use client';

import { VariantText } from '@ebda/ui';
import Image from 'next/image';
import Link from 'next/link';
import type { CartTableProps } from '../types';
import { CartLineUnavailableNotice } from '../shared/CartLineUnavailable';
import { CartLineNote } from '../../components/commerce/CartLineNote';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { cartLineLabel } from '../shared/card-actions';
import { MinusIcon, PlusIcon } from '../shared/icons';

/**
 * Classic template — cart list as a clean, table-style grid. Square
 * corners, thin dividers, formal typography matching Classic's
 * ProductCard language.
 */
export default function ClassicCartTable({
  items,
  isRtl: isRtlProp,
  urlPrefix = '',
  onUpdateQuantity,
  onRemove,
  typography,
}: CartTableProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;
  // The ONE storefront price format (Ruling B1-28).
  const format = useLocalePrice();

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
              className="h-28 w-28 flex-shrink-0 overflow-hidden bg-muted border border-input/60"
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
                    className="inline-block relative min-w-11 before:absolute before:-inset-y-3 before:inset-x-0 before:content-[''] font-medium text-foreground hover:text-primary tracking-tight"
                    style={typography?.name}
                  >
                    {displayName}
                  </Link>
                  {(item.variantTitle || item.variantTitleAr) && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <VariantText
                        title={
                          (isRtl && item.variantTitleAr
                            ? item.variantTitleAr
                            : item.variantTitle || item.variantTitleAr) ?? ''
                        }
                      />
                    </p>
                  )}
                  <CartLineNote note={item.note} />
                  {item.unavailable && <CartLineUnavailableNotice />}
                  {/* Taste re-audit P2-2: at quantity 1 the line total already says it. */}
                  {item.quantity > 1 && (
                    <p
                      className="mt-1 text-sm text-muted-foreground tabular-nums"
                      style={typography?.price}
                    >
                      {format(item.price)}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onRemove?.(item.id)}
                  className="inline-flex min-h-[44px] min-w-11 items-center justify-center text-base uppercase tracking-widest text-muted-foreground hover:text-destructive-ink transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive cursor-pointer"
                  aria-label={cartLineLabel('remove', isRtl, displayName)}
                  style={typography?.cta}
                >
                  {isRtl ? 'إزالة' : 'Remove'}
                </button>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center border border-input">
                  <button
                    type="button"
                    disabled={item.unavailable || item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="h-11 w-11 text-muted-foreground hover:bg-muted disabled:opacity-40 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground cursor-pointer"
                    aria-label={cartLineLabel('decrease', isRtl, displayName)}
                    style={typography?.cta}
                  >
                    <MinusIcon />
                  </button>
                  <span className="w-10 text-center text-sm font-medium" style={typography?.cta}>
                    {localize(item.quantity)}
                  </span>
                  <button
                    type="button"
                    disabled={item.unavailable}
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="h-11 w-11 text-muted-foreground hover:bg-muted transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground cursor-pointer disabled:opacity-40"
                    aria-label={cartLineLabel('increase', isRtl, displayName)}
                    style={typography?.cta}
                  >
                    <PlusIcon />
                  </button>
                </div>
                <p
                  className="text-base font-semibold tracking-tight text-foreground tabular-nums"
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
