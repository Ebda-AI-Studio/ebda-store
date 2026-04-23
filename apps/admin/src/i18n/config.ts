export const locales = ['en', 'ar'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';
export const localeCookieName = 'admin-lang';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'en' || value === 'ar';
}
