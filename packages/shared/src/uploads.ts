/** Per-image ceiling for POST /uploads/image(s). */
export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Files per POST /uploads/images request (Ruling FU46-6, replaces B0-45's 10). The Workers
 * multipart stub pre-buffers up to fileSize × files before any per-file check, so this caps a
 * single request at ~40 MB of Worker memory. The admin sends larger selections in batches.
 */
export const IMAGE_UPLOAD_BATCH_MAX = 4;
