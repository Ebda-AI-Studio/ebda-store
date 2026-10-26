import { isEbdaMediaUrl } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

/**
 * SEC-6: a logo / ogImage a merchant SETS must point at our media origin (the OG card renderer
 * and the storefront embed it server-side). A value equal to what is already stored passes, so an
 * old external logo does not make every later branding save fail. Empty / undefined = no change.
 */
export function assertMediaOriginOrUnchanged(
  incoming: Record<string, string | undefined>,
  current: Record<string, string | null | undefined>,
  storagePublicUrl?: string | null
): void {
  for (const [field, url] of Object.entries(incoming)) {
    if (!url || url === current[field]) continue;
    if (!isEbdaMediaUrl(url, storagePublicUrl)) {
      throw new AppError(
        400,
        'MEDIA_URL_REQUIRED',
        `${field} must be an image uploaded through the media library`
      );
    }
  }
}
