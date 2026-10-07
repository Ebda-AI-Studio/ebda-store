import type { MetadataRoute } from 'next';
import { BRAND } from '@force/shared/brand';

export const dynamic = 'force-static';

/** Web app manifest for ebda.app (icons, theme colour, Arabic-first). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND.product.nameAr} ${BRAND.product.nameEn}`,
    short_name: BRAND.nameAr,
    description: 'اعمل متجرك أونلاين في دقايق.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'ar',
    dir: 'rtl',
    background_color: BRAND.colors.night,
    theme_color: BRAND.colors.night,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
