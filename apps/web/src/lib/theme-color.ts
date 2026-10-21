import { BRAND, type StoreTheme } from '@ebda/shared';

/**
 * The browser chrome colour (`<meta name="theme-color">`, K-08): the store's own page colour, so
 * a white Atelier store is not framed in Ebda's night. Theme colours are bare HSL triplets
 * (composeStoreTheme); anything else passes through. No store / no colour = the platform colour.
 */
export function storeThemeColor(
  theme: Pick<StoreTheme, 'backgroundColor'> | null | undefined
): string {
  const bg = theme?.backgroundColor?.trim();
  if (!bg) return BRAND.colors.night;
  return /^\d/.test(bg) ? `hsl(${bg})` : bg;
}
