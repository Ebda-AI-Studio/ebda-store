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
import { MinusIcon, PlusIcon, cx } from './ui';
import { cartLineLabel } from '../shared/card-actions';

/** The /cart page lines, in the same shape as the bag drawer. */
export default function DahabCartTable({
  items,
  isRtl: isRtlProp,
  urlPrefix = '',
  onUpdateQuantity,
  onRemove,
  typography,
}: CartTableProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const { localize } = useNumerals();
  const formatPrice = useLocalePrice();
  const isRtl = isRtlProp ?? ctxIsRtl;

  return (
    <ul className="divide-y divide-border border-y border-border" dir={isRtl ? 'rtl' : 'ltr'}>
      {items.map(item => {
        const name = (isRtl && item.nameAr ? item.nameAr : item.name) || '';
        const variant =
          (isRtl && item.variantTitleAr ? item.variantTitleAr : item.variantTitle) ||
          item.variantTitleAr;
        return (
          <li
            key={item.id}
            className={cx('flex gap-4 py-6 sm:gap-6', item.unavailable && 'opacity-70')}
          >
            <Link
              href={`${urlPrefix}/products/${item.slug}`}
              {...(item.image ? {} : { 'aria-hidden': true, tabIndex: -1 })}
              className="relative aspect-[4/5] w-24 shrink-0 overflow-hidden rounded-[var(--radius)] bg-card sm:w-28"
            >
              {item.image && (
                <Image src={item.image} alt={name} fill sizes="112px" className="object-cover" />
              )}
            </Link>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link
                    href={`${urlPrefix}/products/${item.slug}`}
                    className="relative min-w-11 before:absolute before:-inset-y-3 before:inset-x-0 before:content-[''] line-clamp-2 text-[15px] leading-snug text-foreground hover:text-primary"
                    style={typography?.name}
                  >
                    {name}
                  </Link>
                  {variant && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <VariantText title={variant} />
                    </p>
                  )}
                  <CartLineNote note={item.note} />
                  {item.unavailable && <CartLineUnavailableNotice />}
                  {/* Taste re-audit P2-2: at quantity 1 the line total already says it. */}
                  {item.quantity > 1 && (
                    <p
                      className="mt-1.5 text-sm tabular-nums text-muted-foreground"
                      style={typography?.price}
                    >
                      {formatPrice(item.price)}
                    </p>
                  )}
                </div>
                <p
                  className="shrink-0 text-[15px] tabular-nums text-primary"
                  style={typography?.price}
                >
                  {item.unavailable ? (
                    <s>{formatPrice(item.price * item.quantity)}</s>
                  ) : (
                    formatPrice(item.price * item.quantity)
                  )}
                </p>
              </div>
              <div className="mt-auto flex items-center justify-between">
                <div className="flex items-center rounded-[var(--radius)] border border-input">
                  <button
                    type="button"
                    disabled={item.unavailable || item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    aria-label={cartLineLabel('decrease', isRtl, name)}
                    className="flex h-11 w-11 items-center justify-center text-foreground/80 hover:text-primary disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MinusIcon className="h-4 w-4" />
                  </button>
                  <span
                    aria-live="polite"
                    className="w-9 text-center text-sm tabular-nums"
                    style={typography?.cta}
                  >
                    {localize(item.quantity)}
                  </span>
                  <button
                    type="button"
                    disabled={item.unavailable}
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    aria-label={cartLineLabel('increase', isRtl, name)}
                    className="flex h-11 w-11 items-center justify-center text-foreground/80 hover:text-primary disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <PlusIcon className="h-4 w-4" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove?.(item.id)}
                  aria-label={cartLineLabel('remove', isRtl, name)}
                  className="min-h-[44px] min-w-11 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={typography?.cta}
                >
                  {t('Remove', 'حذف')}
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
