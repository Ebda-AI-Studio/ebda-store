'use client';

import Image from 'next/image';
import { useLocale } from 'next-intl';
import { BRAND } from '@ebda/shared';

/**
 * The one sign-in lockup for every Ebda surface: the studio first (mark + "Ebda AI Studio"), then the product name.
 * Night + Ebda gold only, no orange. The same markup lives in apps/orders (separate app, no shared UI package).
 */
export function SignInBrand({
  size = 'lg',
  product: which = 'store',
}: {
  size?: 'sm' | 'lg';
  /** The product line under the studio lockup: Ebda Store by default, Ebda Chat when the person came from Chat. */
  product?: 'store' | 'chat' | null;
}) {
  const isAr = useLocale() === 'ar';
  const studio = isAr ? BRAND.company.shortNameAr : BRAND.company.shortNameEn;
  const p = which === 'chat' ? BRAND.productWhatsapp : BRAND.product;
  // `null` = not resolved yet: no product line (the height is reserved) rather than a wrong one.
  const product = which === null ? '' : isAr ? p.nameAr : p.nameEn;
  const h = size === 'lg' ? 40 : 32;
  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex items-center justify-center gap-2.5">
        <Image
          src="/logo-on-light.svg"
          alt=""
          width={Math.round(h * 0.52)}
          height={h}
          className="dark:hidden"
          unoptimized
        />
        <Image
          src="/logo.svg"
          alt=""
          width={Math.round(h * 0.52)}
          height={h}
          className="hidden dark:block"
          unoptimized
        />
        <span className="text-sm font-medium text-primary-ink">{studio}</span>
      </div>
      <p className="mt-3 min-h-8 text-2xl font-bold tracking-tight text-foreground">{product}</p>
    </div>
  );
}
