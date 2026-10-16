/**
 * The one place an image becomes Gemini Vision `inline_data`. Gemini accepts only the types
 * below (https://ai.google.dev/gemini-api/docs/prompting_with_media#supported_file_formats).
 * There is no rasterizing: `sharp` cannot load on workerd, where the API runs (Ruling FU46-8),
 * so a GIF/SVG/ICO/TIFF image is refused with `GeminiImageUnsupported` and each caller turns
 * that into its own clear failure. Uploads store only JPEG/PNG/GIF/WebP (judged by bytes).
 */
const GEMINI_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export class GeminiImageUnsupported extends Error {
  constructor(readonly mimeType: string) {
    super(`AI_IMAGE_UNSUPPORTED_FORMAT: ${mimeType || 'unknown'} cannot be sent to Gemini`);
    this.name = 'GeminiImageUnsupported';
  }
}

export function geminiInlineImage(
  buf: Buffer,
  rawMime: string
): { data: string; mimeType: string } {
  const mimeType = rawMime.split(';')[0].trim().toLowerCase();
  if (!GEMINI_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) throw new GeminiImageUnsupported(mimeType);
  return { data: buf.toString('base64'), mimeType };
}
