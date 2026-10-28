import { isEbdaMediaUrl } from '@ebda/shared';

/**
 * SSRF guard for the OG card renderer (SVG rasterizer AND raster <img>). Store logo/ogImage URLs are
 * tenant-controlled and this route runs server-side, so we must NEVER fetch an
 * arbitrary URL (could hit internal/metadata endpoints). Only allow https URLs
 * on our media origin (R2 `*.r2.dev`, media.ebda.app, or STORAGE_PUBLIC_URL's host).
 */
export function isAllowedAssetUrl(raw: string): boolean {
  return isEbdaMediaUrl(
    raw,
    process.env.NEXT_PUBLIC_MEDIA_ORIGIN || process.env.STORAGE_PUBLIC_URL
  );
}
