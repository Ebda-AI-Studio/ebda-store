'use client';

import { VariantText } from '@ebda/ui';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import type { CartTableProps } from '../types';
import { CartLineUnavailableNotice } from '../shared/CartLineUnavailable';
import { CartLineNote } from '../../components/commerce/CartLineNote';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { cartLineLabel } from '../shared/card-actions';
import { MinusIcon, PlusIcon } from '../shared/icons';

/**
 * Minimal template — cart rendered with ultra-spare typography-first
 * layout. No borders, no backgrounds, just rows separated by
 * whitespace. Matches Minimal's no-chrome design language.
 */
export default function MinimalCartTable({
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
    <div className="space-y-10" dir={isRtl ? 'rtl' : 'ltr'}>
      {items.map(item => {
        const displayName = isRtl && item.nameAr ? item.nameAr : item.name;
        return (
          <div key={item.id} className="flex gap-5">
            <Link
              href={`${urlPrefix}/products/${item.slug}`}
              {...(item.image ? {} : { 'aria-hidden': true, tabIndex: -1 })}
              className="aspect-[3/4] w-20 flex-shrink-0 overflow-hidden bg-muted/30"
            >
              {item.image ? (
                <Image
                  src={item.image}
                  alt={displayName}
                  width={80}
                  height={106}
                  sizes="80px"
                  className="h-full w-full object-cover"
                />
              ) : null}
            </Link>
            <div className="flex flex-1 flex-col justify-between">
              <div>
                <Link
                  href={`${urlPrefix}/products/${item.slug}`}
                  className="inline-block relative min-w-11 before:absolute before:-inset-y-3 before:inset-x-0 before:content-[''] text-sm font-medium text-foreground hover:text-primary"
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
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-3 text-muted-foreground">
                  <button
                    type="button"
                    disabled={item.unavailable || item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="inline-flex h-11 w-11 items-center justify-center hover:text-foreground disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer transition-colors duration-200"
                    aria-label={cartLineLabel('decrease', isRtl, displayName)}
                    style={typography?.cta}
                  >
                    <MinusIcon />
                  </button>
                  <span
                    className="min-w-[1.5ch] text-center text-foreground"
                    style={typography?.cta}
                  >
                    {localize(item.quantity)}
                  </span>
                  <button
                    type="button"
                    disabled={item.unavailable}
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="inline-flex h-11 w-11 items-center justify-center hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer transition-colors duration-200 disabled:opacity-40"
                    aria-label={cartLineLabel('increase', isRtl, displayName)}
                    style={typography?.cta}
                  >
                    <PlusIcon />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove?.(item.id)}
                    className="ms-4 inline-flex min-h-[44px] min-w-11 items-center justify-center text-sm hover:text-destructive-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive cursor-pointer transition-colors duration-200"
                    aria-label={cartLineLabel('remove', isRtl, displayName)}
                    style={typography?.cta}
                  >
                    {isRtl ? 'إزالة' : 'Remove'}
                  </button>
                </div>
                <p className="text-sm text-foreground tabular-nums" style={typography?.price}>
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
