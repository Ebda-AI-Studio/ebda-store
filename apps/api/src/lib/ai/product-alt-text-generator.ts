/**
 * Shared product-image alt-text generation core (Gemini Vision).
 *
 * Fetches the image bytes, rasterizes to a Gemini-supported mime type
 * (mirrors the private `rasterizeForGemini` helper in `ai.service.ts` —
 * duplicated here rather than exported so this bulk-AI module stays
 * self-contained with the plain `config.googleAiKey` + `callWithRetry`
 * plumbing used by every other `bulk-ai-*` generator), then asks Gemini
 * for a concise, descriptive, SEO+a11y-friendly alt string.
 *
 * Used by the `bulk-ai-image-alt` Inngest sweep. No per-image button exists
 * yet, but keeping this as a standalone module (rather than inline in the
 * Inngest function) matches the FAQ/category/excerpt/tags pattern and
 * leaves room for one later.
 */
import { GeminiFailoverClient } from './gemini-keys';
import sharp from 'sharp';
import { safeFetchImage } from '../safe-fetch';
import { rethrowAsAppError } from './gemini-errors';
import { recordUsage } from '../../services/ai.service';

export const ALT_TEXT_MAX_LENGTH = 160;

// Gemini Vision accepts only these mime types for inline_data — see
// https://ai.google.dev/gemini-api/docs/prompting_with_media#supported_file_formats
const GEMINI_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

async function rasterizeForGemini(
  buf: Buffer,
  mimeType: string
): Promise<{ data: string; mimeType: string }> {
  if (GEMINI_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return { data: buf.toString('base64'), mimeType };
  }
  const png = await sharp(buf).png().toBuffer();
  return { data: png.toString('base64'), mimeType: 'image/png' };
}

export interface GenerateProductAltTextInput {
  /** storeId for AI quota-usage attribution (AiUsage row). */
  storeId: string;
  imageUrl: string;
  product: {
    name: string;
    nameAr?: string | null;
  };
}

/**
 * Fetch + rasterize the image, then generate a concise alt string
 * (<=160 chars) via Gemini Vision. Throws on fetch failure, rasterize
 * failure, or a missing/empty model response — the caller (bulk sweep)
 * maps these to a per-image failure entry.
 */
export async function generateProductAltText(
  input: GenerateProductAltTextInput,
  apiKey: string,
  modelName: string
): Promise<string> {
  const { imageUrl, product } = input;

  let imgFetch: Response;
  try {
    // SSRF guard: imageUrl is merchant-controlled — block private/loopback/
    // metadata targets before fetching server-side.
    imgFetch = await safeFetchImage(imageUrl);
  } catch {
    throw new Error('AI_IMAGE_FETCH_FAILED: could not reach the image URL');
  }
  if (!imgFetch.ok) {
    throw new Error(`AI_IMAGE_FETCH_FAILED: HTTP ${imgFetch.status}`);
  }

  const arrayBuf = await imgFetch.arrayBuffer();
  const rawMime = (imgFetch.headers.get('content-type') ?? 'image/jpeg')
    .split(';')[0]
    .trim()
    .toLowerCase();

  const { data: base64, mimeType } = await rasterizeForGemini(Buffer.from(arrayBuf), rawMime);

  const prompt = `Write ONE concise, descriptive alt-text string for this e-commerce product image.

Product: ${product.name}${product.nameAr ? ` / ${product.nameAr}` : ''}

Rules:
- Describe what is visibly shown (color, material, angle, setting) — don't just repeat the product name.
- Optimise for SEO and screen-reader accessibility.
- Maximum ${ALT_TEXT_MAX_LENGTH} characters.
- Output ONLY the alt-text string — no quotes, no markdown, no explanation, no trailing period requirement.`;

  const genai = new GeminiFailoverClient(apiKey);
  const model = genai.getGenerativeModel({ model: modelName });

  let result;
  try {
    result = await model.generateContent([{ inlineData: { mimeType, data: base64 } }, prompt]);
  } catch (err) {
    rethrowAsAppError(err, 'AI alt-text generation failed');
  }

  const usage = result.response.usageMetadata;
  await recordUsage(
    input.storeId,
    'image-alt',
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0,
    false,
    { model: modelName }
  );

  const raw = result.response.text().trim();
  const alt = raw.replace(/^["']|["']$/g, '').trim();

  if (!alt) {
    throw new Error('AI returned an empty alt-text response');
  }

  return alt.slice(0, ALT_TEXT_MAX_LENGTH);
}
