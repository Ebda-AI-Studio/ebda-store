import { REGION } from '@force/shared';
export const locales = ['en', 'ar'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = REGION.defaultLocale === 'en' ? 'en' : 'ar';
export const localeCookieName = 'admin-lang';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'en' || value === 'ar';
}
