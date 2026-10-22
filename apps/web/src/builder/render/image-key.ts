/**
 * Which image setting a rendered picture comes from (canvas only). A localized
 * image is stored as `image` and `imageAr`; the storefront shows the Arabic one
 * in Arabic when it is set and falls back to the other, so the editor must
 * swap the setting that is actually on screen. With neither set the shared
 * `image` is the slot to fill.
 */
export function displayedImageKey(
  arabic: boolean,
  en: string | undefined,
  ar: string | undefined,
  base = 'image'
): string {
  const arKey = `${base}Ar`;
  if (arabic) return ar ? arKey : base;
  return en ? base : ar ? arKey : base;
}

/** The `data-builder-image` attribute for a picture, in editor mode only. */
export function imageMarker(
  editorMode: boolean | undefined,
  key: string
): Record<string, string> | undefined {
  return editorMode ? { 'data-builder-image': key } : undefined;
}
