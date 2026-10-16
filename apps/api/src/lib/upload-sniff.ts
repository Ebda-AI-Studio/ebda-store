/**
 * Magic-byte detection for the image and font uploads (B0-46; the video twin is
 * lib/video-sniff.ts). The multipart mime and the filename are attacker-controlled; the
 * bytes decide what a file is and therefore its stored extension and Content-Type.
 */
export type ImageKind = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export const IMAGE_EXT: Record<ImageKind, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export type FontKind = 'font/woff2' | 'font/woff' | 'font/ttf' | 'font/otf';
export const FONT_EXT: Record<FontKind, string> = {
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
};

export function sniffFont(buf: Buffer): FontKind | null {
  if (buf.length < 4) return null;
  const tag = buf.subarray(0, 4).toString('latin1');
  if (tag === 'wOF2') return 'font/woff2';
  if (tag === 'wOFF') return 'font/woff';
  if (tag === 'OTTO') return 'font/otf';
  if (tag === 'true' || buf.readUInt32BE(0) === 0x00010000) return 'font/ttf';
  return null;
}

/** `photo.png` + `image/jpeg` → `photo.jpg`; an empty base becomes `fallback`. */
export function renameByKind(originalName: string, ext: string, fallback: string): string {
  return `${originalName.replace(/\.[^.]*$/, '') || fallback}${ext}`;
}

/**
 * The 400 body for a file whose bytes are not what the route accepts: generic (it names the
 * accepted formats, never the file, a path or what the bytes looked like) and in both
 * languages (`details.messageEn` / `details.messageAr`, the admin's `localizedApiMessage`
 * convention).
 */
export const UPLOAD_CONTENT_ERRORS = {
  image: {
    code: 'INVALID_IMAGE_CONTENT',
    en: 'The file is not a JPEG, PNG, GIF or WebP image',
    ar: 'الملف ليس صورة JPEG أو PNG أو GIF أو WebP',
  },
  receipt: {
    code: 'INVALID_IMAGE_CONTENT',
    en: 'The receipt must be a JPEG, PNG or WebP image',
    ar: 'يجب أن يكون الإيصال صورة JPEG أو PNG أو WebP',
  },
  font: {
    code: 'INVALID_FONT_CONTENT',
    en: 'The file is not a WOFF2, WOFF, TTF or OTF font',
    ar: 'الملف ليس خطًا بصيغة WOFF2 أو WOFF أو TTF أو OTF',
  },
} as const;

export function uploadContentError(kind: keyof typeof UPLOAD_CONTENT_ERRORS): {
  code: string;
  message: string;
  details: { messageEn: string; messageAr: string };
} {
  const e = UPLOAD_CONTENT_ERRORS[kind];
  return { code: e.code, message: e.en, details: { messageEn: e.en, messageAr: e.ar } };
}
