/**
 * Where a store's font URLs may point (Ruling VE-4 follow-up, cross-tenant object deletion).
 *
 * A font in a store's typography is a merchant-supplied URL, and when it later leaves the library the
 * platform deletes the object behind it (`deleteR2ObjectIfOrphan`). A URL into ANOTHER store's R2
 * namespace must therefore never be accepted in the first place:
 *   - a CUSTOM font is a file this store uploaded: `stores/<storeId>/fonts/...` in our bucket;
 *   - a GOOGLE font is a stylesheet on the platform's allowlisted origin (`fonts.googleapis.com`).
 * Anything else is refused at the edge (the typography PUT and every page-document write); the delete
 * itself ALSO refuses a foreign key (`mayDeleteKey`), so neither check is the only one.
 */
import { r2KeyBelongsToStore, urlToR2Key } from '../services/r2-cleanup.service';

export const GOOGLE_FONTS_ORIGIN = 'https://fonts.googleapis.com/';

export interface FontLike {
  type: 'google' | 'custom';
  url: string;
}

/** Why `font` may not be stored for `storeId`, or null when it may. */
export function fontUrlProblem(storeId: string, font: FontLike): string | null {
  if (font.type === 'google')
    return font.url.startsWith(GOOGLE_FONTS_ORIGIN)
      ? null
      : `Google font URLs must start with ${GOOGLE_FONTS_ORIGIN}`;
  const key = urlToR2Key(font.url);
  if (!key) return 'A custom font must be a file uploaded to this store.';
  if (!r2KeyBelongsToStore(key, storeId) || !key.startsWith(`stores/${storeId}/fonts/`))
    return 'A custom font must be a file uploaded to this store.';
  return null;
}

/** Every refused font of a library, with its index. */
export function fontLibraryProblems(
  storeId: string,
  fonts: readonly FontLike[] | undefined
): Array<{ index: number; reason: string }> {
  const out: Array<{ index: number; reason: string }> = [];
  (fonts ?? []).forEach((f, index) => {
    const reason = fontUrlProblem(storeId, f);
    if (reason) out.push({ index, reason });
  });
  return out;
}
