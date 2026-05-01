'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { CartTableProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * Bold template — cart as heavy-blocked rows with strong borders,
 * uppercase labels, and sharp contrast. Matches Bold's ProductCard +
 * Header language (gray-950 blocks, solid buttons).
 */
export default function BoldCartTable({
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
                  >
                    {displayName}
                  </Link>
                  <p className="mt-1 text-sm font-bold uppercase tracking-wider text-primary">
                    {format(item.price)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove?.(item.id)}
                  className="h-11 w-11 flex-shrink-0 border-2 border-foreground bg-background text-2xl font-black text-foreground hover:bg-destructive hover:text-destructive-foreground hover:border-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 cursor-pointer"
                  aria-label={isRtl ? 'إزالة' : 'Remove'}
                >
                  ×
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center border-2 border-foreground">
                  <button
                    type="button"
                    disabled={item.quantity <= 1}
                    onClick={() => onUpdateQuantity?.(item.id, Math.max(1, item.quantity - 1))}
                    className="h-11 w-11 font-black text-foreground hover:bg-foreground hover:text-background disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1 cursor-pointer"
                    aria-label={isRtl ? 'تقليل' : 'Decrease'}
                  >
                    −
                  </button>
                  <span className="border-x-2 border-foreground w-10 text-center text-sm font-black">
                    {item.quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity?.(item.id, item.quantity + 1)}
                    className="h-11 w-11 font-black text-foreground hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1 cursor-pointer"
                    aria-label={isRtl ? 'زيادة' : 'Increase'}
                  >
                    +
                  </button>
                </div>
                <p className="text-base font-black uppercase tracking-tight text-foreground">
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
