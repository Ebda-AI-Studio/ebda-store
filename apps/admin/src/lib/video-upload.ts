/** Client-side video guards for the builder VideoField (the API re-checks both). */
export const VIDEO_MAX_BYTES = 6 * 1024 * 1024;
export const VIDEO_ACCEPT = 'video/mp4,video/webm';

export type VideoCheck = 'ok' | 'too-large' | 'bad-type';

export function checkVideoFile(file: { size: number; type: string }): VideoCheck {
  if (file.type !== 'video/mp4' && file.type !== 'video/webm') return 'bad-type';
  if (file.size > VIDEO_MAX_BYTES) return 'too-large';
  return 'ok';
}

/**
 * Megabytes with one decimal ("2.4" / "٢٫٤"), never "NaN". Arabic-Indic digits in
 * Arabic so the readout matches the «الفيديو أكبر من ٦ ميجا» message.
 */
export function formatMegabytes(bytes: number, locale = 'en'): string {
  const mb = Number.isFinite(bytes) && bytes >= 0 ? bytes / (1024 * 1024) : 0;
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG-u-nu-arab' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(mb);
}
