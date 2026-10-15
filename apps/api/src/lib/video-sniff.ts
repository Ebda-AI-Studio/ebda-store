/**
 * Magic-byte detection for the two video containers the page builder accepts.
 * The declared multipart mime is attacker-controlled; the bytes decide.
 *
 * - MP4: an ISO-BMFF `ftyp` box (offset 4) whose major brand (bytes 8-12) is an mp4 brand.
 * - WebM: the EBML magic `1A 45 DF A3` AND the `webm` DocType within the first
 *   64 bytes (a Matroska `.mkv` shares the magic but is not what we serve as
 *   `video/webm`).
 */
export type VideoKind = 'video/mp4' | 'video/webm';

export const VIDEO_MAX_BYTES = 6 * 1024 * 1024;

/** ISO-BMFF major brands we serve as `video/mp4`. HEIC/AVIF/QuickTime/3GP are NOT mp4. */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
]);

export function sniffVideo(buf: Buffer): VideoKind | null {
  if (
    buf.length >= 12 &&
    buf.subarray(4, 8).toString('latin1') === 'ftyp' &&
    MP4_BRANDS.has(buf.subarray(8, 12).toString('latin1'))
  ) {
    return 'video/mp4';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3 &&
    buf.subarray(0, 64).includes(Buffer.from('webm', 'latin1'))
  ) {
    return 'video/webm';
  }
  return null;
}
