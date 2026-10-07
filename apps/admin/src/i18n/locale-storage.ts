import { isLocale, localeCookieName, type Locale } from './config';

export const localeStorageKey = 'admin-lang';
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Persist the UI language: cookie (read by the server) + localStorage (survives Safari ITP's 7-day cookie cap). */
export function persistLocale(locale: Locale): void {
  document.cookie = `${localeCookieName}=${locale}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
  try {
    localStorage.setItem(localeStorageKey, locale);
  } catch {
    // storage blocked — the cookie alone still works
  }
}

/** The locale saved in localStorage when the cookie has been purged, else null. */
export function restorableLocale(active: string): Locale | null {
  try {
    if (document.cookie.includes(`${localeCookieName}=`)) return null;
    const saved = localStorage.getItem(localeStorageKey);
    return isLocale(saved) && saved !== active ? saved : null;
  } catch {
    return null;
  }
}
