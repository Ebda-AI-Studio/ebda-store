import type { MetadataRoute } from 'next';
import { BRAND } from '@ebda/shared/brand';

export const dynamic = 'force-static';

/** Web app manifest for ebda.app (icons, theme colour, Arabic-first). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND.company.shortNameAr} ${BRAND.company.shortNameEn}`,
    short_name: BRAND.company.shortNameAr,
    description:
      'ابدأ ستوديو للذكاء الاصطناعي بيعمل منتجات لأصحاب الشغل: ابدأ ستور لمتجرك، وابدأ شات لعملائك.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'ar',
    dir: 'rtl',
    background_color: '#fafafa',
    theme_color: '#fafafa',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
