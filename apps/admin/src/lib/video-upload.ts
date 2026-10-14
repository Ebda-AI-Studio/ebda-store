/** Client-side video guards for the builder VideoField (the API re-checks both). */
export const VIDEO_MAX_BYTES = 6 * 1024 * 1024;
export const VIDEO_ACCEPT = 'video/mp4,video/webm';

export type VideoCheck = 'ok' | 'too-large' | 'bad-type';

export function checkVideoFile(file: { size: number; type: string }): VideoCheck {
  if (file.type !== 'video/mp4' && file.type !== 'video/webm') return 'bad-type';
  if (file.size > VIDEO_MAX_BYTES) return 'too-large';
  return 'ok';
}

/** Megabytes with one decimal, e.g. 2.4 (never "NaN"). */
export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0.0';
  return (bytes / (1024 * 1024)).toFixed(1);
}
