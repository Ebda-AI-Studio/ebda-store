'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { CartTableProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * Minimal template — cart rendered with ultra-spare typography-first
 * layout. No borders, no backgrounds, just rows separated by
 * whitespace. Matches Minimal's no-chrome design language.
 */
export default function MinimalCartTable({
  items,
  isRtl: isRtlProp,
  currency = 'KWD',
  urlPrefix = '',
  onUpdateQuantity,
  onRemove,
}: CartTableProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const format = (price: number) => `${(price / 1000).toFixed(3)} ${currency}`;

  return (
    <div className="space-y-10" dir={isRtl ? 'rtl' : 'ltr'}>
      {items.map(item => {
        const displayName = isRtl && item.nameAr ? item.nameAr : item.name;
        return (
          <div key={item.id} className="flex gap-5">
            <Link
              href={`${urlPrefix}/products/${item.slug}`}
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
                  className="text-sm font-medium text-foreground hover:text-primary"
                >
                  {displayName}
                </Link>
                <p className="mt-1 text-sm text-muted-foreground">{format(item.price)}</p>
              </div>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-3 text-muted-foreground">
                  <button
                    disabled={item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="hover:text-foreground disabled:opacity-30"
                    aria-label={isRtl ? 'تقليل' : 'Decrease'}
                  >
                    −
                  </button>
                  <span className="min-w-[1.5ch] text-center text-foreground">{item.quantity}</span>
                  <button
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="hover:text-foreground"
                    aria-label={isRtl ? 'زيادة' : 'Increase'}
                  >
                    +
                  </button>
                  <button
                    onClick={() => onRemove?.(item.id)}
                    className="ms-4 text-xs hover:text-destructive"
                    aria-label={isRtl ? 'إزالة' : 'Remove'}
                  >
                    {isRtl ? 'إزالة' : 'Remove'}
                  </button>
                </div>
                <p className="text-sm text-foreground">{format(item.price * item.quantity)}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
