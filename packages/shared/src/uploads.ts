/** Per-image ceiling for POST /uploads/image(s). */
export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Files per POST /uploads/images request (Ruling FU46-6, replaces B0-45's 10). The Workers
 * multipart stub pre-buffers up to fileSize × files before any per-file check, so this caps a
 * single request at ~40 MB of Worker memory. The admin sends larger selections in batches.
 */
export const IMAGE_UPLOAD_BATCH_MAX = 4;
/**
 * The image types POST /uploads/image(s) stores, decided server-side by magic bytes
 * (apps/api/src/lib/upload-sniff.ts `IMAGE_EXT`; a parity test pins the two together). The
 * admin picker and its client-side check use this list so a file the server will refuse
 * (HEIC, AVIF, SVG, ICO) is named and refused before any upload starts.
 */
export const IMAGE_UPLOAD_ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
/** `IMAGE_UPLOAD_ACCEPTED_TYPES` as an `<input accept>` value. */
export const IMAGE_UPLOAD_ACCEPT = IMAGE_UPLOAD_ACCEPTED_TYPES.join(',');
