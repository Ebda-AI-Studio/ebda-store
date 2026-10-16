/**
 * Ebda AI assistant — translation, SEO meta, category suggestions,
 * and logo-to-palette vision extraction.
 *
 * Provider: Google Gemini 2.0 Flash (free tier — 15 req/min, ~1500
 * req/day per project). Strong Arabic + English handling, native
 * JSON output mode, and zero cost at our current scale. Swap to a
 * paid tier or different provider by editing only this file.
 *
 * Rate limiting / abuse protection lives in three layers:
 *   1. Per-route express limiter (`writeLimiter`)
 *   2. Per-store daily token budget (`AI_DAILY_TOKEN_BUDGET_PER_STORE`)
 *   3. Redis cache (7-day TTL) — identical input returns cached output
 *      without a model call
 *
 * Every call writes an `AiUsage` row so `cached_hit=true` and token
 * usage can be aggregated for billing/audit later.
 */
import { GeminiFailoverClient } from '../lib/ai/gemini-keys';
import { z } from 'zod';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { prisma } from '@ebda/database';
import { config } from '../config';
import { redis } from './redis.service';
import { AppError } from '../middleware/error-handler';
import { assertAiQuota } from '../lib/ai-quota';
import logger from '../lib/logger';
import { computeCostMicros } from '../lib/ai-pricing';
import { safeFetchImage } from '../lib/safe-fetch';
import { sanitizeJsonControlChars } from '../lib/ai/parse-ai-json';
import { rethrowAsAppError } from '../lib/ai/gemini-errors';
import { withSavepoint } from '../lib/savepoint';

// Gemini Vision accepts only these mime types for inline_data. Anything else
// (image/svg+xml, image/gif, image/tiff, image/x-icon) gets a 400. We
// rasterize via sharp to PNG before sending. Keep this in sync with
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
  // sharp handles SVG, GIF (first frame), TIFF, ICO, BMP, AVIF natively.
  const png = await sharp(buf).png().toBuffer();
  return { data: png.toString('base64'), mimeType: 'image/png' };
}

type Feature =
  | 'translate'
  | 'seo'
  | 'categorize'
  | 'section'
  | 'product-faqs'
  | 'aeo'
  | 'geo'
  | 'recommendations'
  | 'tags'
  // Search words (dialect / Franco / EN) for products.search_terms — search program P1.
  | 'search-terms'
  | 'image-alt'
  | 'excerpt'
  | 'answer_engine_gemini'
  | 'answer_engine_perplexity'
  | 'answer_engine_openai'
  | 'campaign'
  // Accounting smart layer — called through accounting/gemini-ai.service.ts,
  // which records through `recordUsage` below so these rows carry model +
  // cost like every other AI call (#1037).
  | AccountingAiFeature;

/** Feature labels the accounting smart layer writes to ai_usage. */
export type AccountingAiFeature =
  | 'reorder-scan'
  | 'deadstock-scan'
  | 'expense-ocr'
  // InstaPay transfer receipts (money batch A): pre-fills the payer's proof form.
  | 'instapay-receipt'
  | 'profit-anomaly'
  | 'insights-narration-cohort'
  | 'insights-narration-funnel'
  | 'insights-narration-segment';
type Lang = 'en' | 'ar';

export type TranslationKind =
  | 'product-name'
  | 'product-description'
  | 'category-name'
  | 'category-description'
  | 'meta-title'
  | 'meta-description'
  | 'store-name'
  | 'store-description'
  | 'free';

export type SeoKind = 'store' | 'category' | 'product';

export interface SeoSuggestion {
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  keywords: string[];
}

export interface CategorySuggestion {
  id: string;
  name: string;
  nameAr: string | null;
  confidence: 'high' | 'medium' | 'low';
}

// Default model is `gemini-flash-lite-latest` — Google's auto-
// updated alias for the cheapest / highest-throughput Flash model.
// Lite has substantially higher free-tier RPM (~30) than the
// standard flash (~10), which matters for bulk catalogue sweeps.
// Quality is imperceptibly different for translation / SEO /
// classification tasks. Override via GEMINI_MODEL env var to flip
// to a paid tier (e.g. gemini-2.5-flash) once billing is enabled.
//
// Verified models on free tier (as of 2026-05-03):
//   gemini-flash-lite-latest  (best for bulk — higher RPM)
//   gemini-2.5-flash-lite     (specific snapshot)
//   gemini-flash-latest       (works but lower RPM, hits quota in bulk)
// `gemini-2.0-flash` + `gemini-2.0-flash-lite` are paid-only on
// this account; `gemini-1.5-flash` is deprecated from v1beta.
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const META_TITLE_MAX = 60;
const META_DESCRIPTION_MAX = 160;

let cachedClient: GeminiFailoverClient | null = null;
function getClient(): GeminiFailoverClient {
  if (!config.googleAiKey) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI features are not configured on this server.');
  }
  if (!cachedClient) cachedClient = new GeminiFailoverClient();
  return cachedClient;
}

function ensureEnabled(): void {
  if (!config.aiFeaturesEnabled) {
    throw new AppError(503, 'AI_DISABLED', 'AI features are temporarily disabled.');
  }
}

async function checkBudget(storeId: string): Promise<void> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const result = await prisma.aiUsage.aggregate({
    where: { storeId, createdAt: { gte: since }, cachedHit: false },
    _sum: { inputTokens: true, outputTokens: true },
  });
  const used = (result._sum.inputTokens ?? 0) + (result._sum.outputTokens ?? 0);
  if (used >= config.aiDailyTokenBudgetPerStore) {
    throw new AppError(
      429,
      'AI_BUDGET_EXCEEDED',
      `Daily AI token budget reached (${used}/${config.aiDailyTokenBudgetPerStore}). Try again tomorrow or contact support to raise the limit.`
    );
  }
}

function cacheKey(feature: Feature, payload: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
  return `ai:${feature}:${hash}`;
}

/**
 * Provenance + costing for one AI call. All optional so the 28 existing
 * call sites keep working unchanged — they still get `model` and `costMicros`
 * because both are resolved here rather than at the call site.
 */
export interface UsageProvenance {
  /** Model that produced the output. Defaults to the same env resolution the
   *  callers use, so cost is still attributed correctly when omitted. */
  model?: string;
  /** What the output was attached to, e.g. 'product'. */
  subjectType?: string;
  subjectId?: string;
}

export async function recordUsage(
  storeId: string,
  feature: Feature,
  inputTokens: number,
  outputTokens: number,
  cachedHit: boolean,
  provenance: UsageProvenance = {}
): Promise<void> {
  try {
    // Resolved here, not at the call site: every existing caller then records
    // provenance + cost without being touched, and a new caller cannot forget.
    const model = provenance.model ?? process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';

    // A cached hit consumed no provider tokens, so it genuinely cost 0 —
    // distinct from `null`, which means "no rate configured for this model".
    // Collapsing the two would make an unpriced deployment look free.
    const costMicros = cachedHit ? 0 : computeCostMicros(model, inputTokens, outputTokens);

    // Savepointed: this usage row is written from request handlers that run
    // in the request's single tenant transaction, and the catch below
    // swallows — an unguarded failure would abort that transaction and turn
    // the handler's 2xx into a silent rollback (issue 2215's class).
    await withSavepoint(() =>
      prisma.aiUsage.create({
        data: {
          storeId,
          feature,
          inputTokens,
          outputTokens,
          cachedHit,
          model,
          costMicros,
          subjectType: provenance.subjectType ?? null,
          subjectId: provenance.subjectId ?? null,
        },
      })
    );
  } catch (err) {
    // Never fail the user-facing request because we couldn't log usage.
    logger.warn({ err, storeId, feature }, 'Failed to record AI usage');
  }
}

/**
 * Strip Markdown code fences AND escape unescaped control characters
 * inside string literals. Gemini occasionally returns either, even with
 * responseMimeType:application/json set. Defensive — most calls don't
 * need it but 2026-05-28 Palestinian zatar citation copy proved the
 * second pass is non-optional.
 */
function stripJsonFences(text: string): string {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  return sanitizeJsonControlChars(stripped);
}

// ---------------------------------------------------------------------------
// Logo-to-palette vision types (Layer C)
// ---------------------------------------------------------------------------

const paletteExtractionSchema = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  neutral: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

// Model output is untrusted input. The hand-rolled `typeof x !== 'string'`
// chains these replace checked that scalars were present, but not:
//   - element types inside arrays (`Array.isArray(keywords)` accepted
//     `[{...}, 42]`, which reaches a meta tag as "[object Object]")
//   - the `confidence` enum (any string flowed through to the admin UI)
//   - `matches` actually being an array (a non-array threw a TypeError
//     out of `.filter`, surfacing as a 500 instead of a clean 502)
//   - any length bound (nothing stopped a 50 KB title reaching the DB)
// Bounds are generous — they exist to stop absurd output, not to trim.
export const seoSuggestionSchema = z.object({
  title: z.string().max(300),
  titleAr: z.string().max(300),
  description: z.string().max(2000),
  descriptionAr: z.string().max(2000),
  keywords: z.array(z.string().max(120)).max(50),
});

export const sectionContentSchema = z.object({
  kicker: z.string().max(200),
  kickerAr: z.string().max(200),
  subtitle: z.string().max(600),
  subtitleAr: z.string().max(600),
});

export const campaignDraftAiSchema = z.object({
  subject: z.string().max(200),
  subjectAr: z.string().max(200),
  bodyHtml: z.string().max(20_000),
  bodyHtmlAr: z.string().max(20_000),
});

export const categorizeSchema = z.object({
  matches: z
    .array(z.object({ id: z.string(), confidence: z.enum(['high', 'medium', 'low']) }))
    .max(100),
});

/**
 * Parse + validate a Gemini JSON response in one step.
 *
 * Both failure modes (non-JSON, and JSON of the wrong shape) become the same
 * 502 the callers already returned, with the raw payload logged for triage.
 */
export function parseAiJson<T>(
  schema: z.ZodType<T>,
  raw: string,
  ctx: { storeId: string; kind: string }
): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    logger.error({ err, raw, ...ctx }, `Gemini returned non-JSON for ${ctx.kind}`);
    throw new AppError(502, 'AI_BAD_RESPONSE', 'AI returned an unexpected response format.');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    logger.error(
      { issues: result.error.issues, raw, ...ctx },
      `Gemini returned bad shape for ${ctx.kind}`
    );
    throw new AppError(502, 'AI_BAD_RESPONSE', 'AI returned an incomplete response.');
  }
  return result.data;
}

export type ExtractedPalette = z.infer<typeof paletteExtractionSchema>;

export class AIService {
  /**
   * Translate a string between English and Arabic. The kind argument
   * lets the model adjust tone (product-name vs free text vs meta
   * description with a length limit).
   */
  static async translate(input: {
    storeId: string;
    text: string;
    from: Lang;
    to: Lang;
    kind: TranslationKind;
  }): Promise<{ translation: string; cached: boolean }> {
    ensureEnabled();
    const trimmed = input.text.trim();
    if (!trimmed) return { translation: '', cached: false };
    if (input.from === input.to) return { translation: trimmed, cached: false };

    // storeId is part of the key so the 7-day translate cache is per-tenant,
    // matching suggestSeo/suggestSectionContent (which hash storeId-bearing
    // input) and suggestCategories (store-owned UUIDs). Without it two tenants
    // shared a cache entry keyed only on the submitted text.
    const key = cacheKey('translate', {
      storeId: input.storeId,
      text: trimmed,
      from: input.from,
      to: input.to,
      kind: input.kind,
    });
    const hit = await redis.get(key);
    if (hit) {
      await recordUsage(input.storeId, 'translate', 0, 0, true);
      return { translation: hit, cached: true };
    }

    await assertAiQuota({ storeId: input.storeId });
    await checkBudget(input.storeId);

    const lengthHint =
      input.kind === 'meta-title'
        ? ` Stay under ${META_TITLE_MAX} characters.`
        : input.kind === 'meta-description'
          ? ` Stay under ${META_DESCRIPTION_MAX} characters.`
          : '';

    const systemInstruction =
      'You translate Egyptian e-commerce content between English and Arabic. ' +
      'Preserve brand names, product codes, sizes, units, and numbers exactly. ' +
      'Keep the same tone (formal/casual) as the source. ' +
      'Output only the translation as plain text — no quotes, no labels, no commentary.';

    const userPrompt = `Translate from ${input.from === 'en' ? 'English' : 'Arabic'} to ${
      input.to === 'en' ? 'English' : 'Arabic'
    }. Kind: ${input.kind}.${lengthHint}\n\nSource:\n${trimmed}`;

    const model = getClient().getGenerativeModel({ model: MODEL, systemInstruction });
    let res;
    try {
      res = await model.generateContent(userPrompt);
    } catch (err) {
      rethrowAsAppError(err, 'AI translation failed');
    }
    const translation = res.response.text().trim();

    const usage = res.response.usageMetadata;
    await recordUsage(
      input.storeId,
      'translate',
      usage?.promptTokenCount ?? 0,
      usage?.candidatesTokenCount ?? 0,
      false
    );

    await redis.set(key, translation, CACHE_TTL_SECONDS);
    return { translation, cached: false };
  }

  /**
   * Generate SEO meta (title, description, keywords) in both English
   * and Arabic for a store, category, or product.
   */
  static async suggestSeo(input: {
    storeId: string;
    kind: SeoKind;
    storeName: string;
    storeNameAr?: string | null;
    entityName: string;
    entityNameAr?: string | null;
    entityDescription?: string | null;
    entityDescriptionAr?: string | null;
    categoryNames?: string[];
  }): Promise<{ suggestion: SeoSuggestion; cached: boolean }> {
    ensureEnabled();

    const key = cacheKey('seo', input);
    const hit = await redis.get(key);
    if (hit) {
      await recordUsage(input.storeId, 'seo', 0, 0, true);
      return { suggestion: JSON.parse(hit) as SeoSuggestion, cached: true };
    }

    await assertAiQuota({ storeId: input.storeId });
    await checkBudget(input.storeId);

    const systemInstruction =
      'You write SEO meta for Egyptian e-commerce stores. Output only valid JSON ' +
      'matching this shape exactly: {"title": string, "titleAr": string, ' +
      '"description": string, "descriptionAr": string, "keywords": string[]}. ' +
      `Title under ${META_TITLE_MAX} characters. Description under ${META_DESCRIPTION_MAX} characters. ` +
      'Keywords: 5-10 short Egypt + GCC search phrases. Do not mention prices ' +
      'or out-of-stock status. Match how Egyptian shoppers actually search.';

    const detailLines = [
      `Store: ${input.storeName}${input.storeNameAr ? ` / ${input.storeNameAr}` : ''}`,
      `Kind: ${input.kind}`,
      `Name: ${input.entityName}${input.entityNameAr ? ` / ${input.entityNameAr}` : ''}`,
      input.entityDescription && `Description: ${input.entityDescription}`,
      input.entityDescriptionAr && `Description (AR): ${input.entityDescriptionAr}`,
      input.categoryNames?.length && `Categories: ${input.categoryNames.join(', ')}`,
    ].filter(Boolean);

    const userPrompt = `Generate SEO meta:\n\n${detailLines.join('\n')}`;

    const model = getClient().getGenerativeModel({
      model: MODEL,
      systemInstruction,
      generationConfig: { responseMimeType: 'application/json' },
    });
    let res;
    try {
      res = await model.generateContent(userPrompt);
    } catch (err) {
      rethrowAsAppError(err, 'AI SEO generation failed');
    }
    const raw = stripJsonFences(res.response.text());

    const parsed: SeoSuggestion = parseAiJson(seoSuggestionSchema, raw, {
      storeId: input.storeId,
      kind: 'SEO',
    });

    const usage = res.response.usageMetadata;
    await recordUsage(
      input.storeId,
      'seo',
      usage?.promptTokenCount ?? 0,
      usage?.candidatesTokenCount ?? 0,
      false
    );

    await redis.set(key, JSON.stringify(parsed), CACHE_TTL_SECONDS);
    return { suggestion: parsed, cached: false };
  }

  /**
   * Generate kicker (short uppercase eyebrow badge) + subtitle (one-
   * line tagline) for a homepage section. Used by the admin Layout
   * page's "Generate with AI" button next to those fields. Bilingual
   * EN+AR in one call. Ahmad 2026-05-16: AI sweep for the new
   * section-content fields.
   */
  static async suggestSectionContent(input: {
    storeId: string;
    section: 'categories' | 'newArrivals' | 'bestSellers' | 'featured' | 'testimonials';
    storeName: string;
    storeNameAr?: string | null;
    storeDescription?: string | null;
    storeDescriptionAr?: string | null;
    /** Sample category names to ground "explore by category" copy. */
    categoryNames?: string[];
    /** Existing title so the AI generates kicker/subtitle consistent with the
     *  merchant's chosen heading rather than fighting it. Optional. */
    existingTitle?: string;
    existingTitleAr?: string;
  }): Promise<{
    suggestion: { kicker: string; kickerAr: string; subtitle: string; subtitleAr: string };
    cached: boolean;
  }> {
    ensureEnabled();

    const key = cacheKey('section', input);
    const hit = await redis.get(key);
    if (hit) {
      await recordUsage(input.storeId, 'section', 0, 0, true);
      return {
        suggestion: JSON.parse(hit) as {
          kicker: string;
          kickerAr: string;
          subtitle: string;
          subtitleAr: string;
        },
        cached: true,
      };
    }

    await assertAiQuota({ storeId: input.storeId });
    await checkBudget(input.storeId);

    const systemInstruction =
      'You write homepage section copy for Egyptian e-commerce stores. Output only ' +
      'valid JSON matching this shape exactly: {"kicker": string, "kickerAr": string, ' +
      '"subtitle": string, "subtitleAr": string}. ' +
      'kicker: 1-2 short uppercase words, max 16 chars (e.g. "EXPLORE", "JUST IN", ' +
      '"SHOP NOW"). Will render in a small colored chip above the title. ' +
      'subtitle: one short tagline, max 80 chars, sentence case. Will render as a ' +
      'muted line below the title. ' +
      'Both fields must work alongside the merchant-chosen title without repeating it. ' +
      'Match how Egyptian shoppers actually talk (informal but professional, no fake hype).';

    const detailLines = [
      `Store: ${input.storeName}${input.storeNameAr ? ` / ${input.storeNameAr}` : ''}`,
      input.storeDescription && `About: ${input.storeDescription}`,
      input.storeDescriptionAr && `About (AR): ${input.storeDescriptionAr}`,
      `Section: ${input.section}`,
      input.existingTitle && `Existing title: ${input.existingTitle}`,
      input.existingTitleAr && `Existing title (AR): ${input.existingTitleAr}`,
      input.categoryNames?.length &&
        `Sample categories: ${input.categoryNames.slice(0, 8).join(', ')}`,
    ].filter(Boolean);

    const userPrompt = `Write kicker + subtitle for this homepage section:\n\n${detailLines.join('\n')}`;

    const model = getClient().getGenerativeModel({
      model: MODEL,
      systemInstruction,
      generationConfig: { responseMimeType: 'application/json' },
    });
    let res;
    try {
      res = await model.generateContent(userPrompt);
    } catch (err) {
      rethrowAsAppError(err, 'AI section content generation failed');
    }
    const raw = stripJsonFences(res.response.text());

    const parsed = parseAiJson(sectionContentSchema, raw, {
      storeId: input.storeId,
      kind: 'section content',
    });

    const usage = res.response.usageMetadata;
    await recordUsage(
      input.storeId,
      'section',
      usage?.promptTokenCount ?? 0,
      usage?.candidatesTokenCount ?? 0,
      false
    );

    await redis.set(key, JSON.stringify(parsed), CACHE_TTL_SECONDS);
    return { suggestion: parsed, cached: false };
  }

  /**
   * Draft a marketing email (subject + simple HTML body) in EN and AR from a
   * merchant's one-line brief. Used by the campaign editor's "AI draft"
   * button (D2). The caller sanitizes the HTML before returning it; the
   * merchant reviews and edits before anything can be sent.
   */
  static async suggestCampaignDraft(input: {
    storeId: string;
    brief: string;
    storeName: string;
    storeNameAr?: string | null;
    storeDescription?: string | null;
    storeDescriptionAr?: string | null;
  }): Promise<{ suggestion: z.infer<typeof campaignDraftAiSchema>; cached: boolean }> {
    ensureEnabled();

    const key = cacheKey('campaign', input);
    const hit = await redis.get(key);
    if (hit) {
      await recordUsage(input.storeId, 'campaign', 0, 0, true);
      return { suggestion: JSON.parse(hit) as z.infer<typeof campaignDraftAiSchema>, cached: true };
    }

    await assertAiQuota({ storeId: input.storeId });
    await checkBudget(input.storeId);

    const systemInstruction =
      'You write short marketing emails for Egyptian e-commerce stores. Output only valid ' +
      'JSON matching this shape exactly: {"subject": string, "subjectAr": string, ' +
      '"bodyHtml": string, "bodyHtmlAr": string}. subject: max 70 chars, no emoji spam, ' +
      'no ALL CAPS. bodyHtml: 2-4 short paragraphs using ONLY <p>, <h2>, <strong>, <em>, ' +
      '<ul>, <li> and <a href="https://..."> tags — no <html>/<head>/<body>, no styles, no ' +
      'images, no scripts. Do not invent prices, discounts, codes, dates or URLs that the ' +
      'brief does not give; if the brief gives none, write copy that needs none. Do not add ' +
      'an unsubscribe line (the platform adds one). The Arabic version is natural, ' +
      'Egypt-friendly Modern Standard Arabic, not a literal translation. Match how Egyptian shoppers ' +
      'actually talk: warm, professional, no fake hype.';

    const detailLines = [
      `Store: ${input.storeName}${input.storeNameAr ? ` / ${input.storeNameAr}` : ''}`,
      input.storeDescription && `About: ${input.storeDescription}`,
      input.storeDescriptionAr && `About (AR): ${input.storeDescriptionAr}`,
      `Brief from the merchant: ${input.brief}`,
    ].filter(Boolean);

    const model = getClient().getGenerativeModel({
      model: MODEL,
      systemInstruction,
      generationConfig: { responseMimeType: 'application/json' },
    });
    let res;
    try {
      res = await model.generateContent(`Write this campaign email:\n\n${detailLines.join('\n')}`);
    } catch (err) {
      rethrowAsAppError(err, 'AI campaign draft generation failed');
    }
    const raw = stripJsonFences(res.response.text());
    const parsed = parseAiJson(campaignDraftAiSchema, raw, {
      storeId: input.storeId,
      kind: 'campaign draft',
    });

    const usage = res.response.usageMetadata;
    await recordUsage(
      input.storeId,
      'campaign',
      usage?.promptTokenCount ?? 0,
      usage?.candidatesTokenCount ?? 0,
      false
    );

    await redis.set(key, JSON.stringify(parsed), CACHE_TTL_SECONDS);
    return { suggestion: parsed, cached: false };
  }

  /**
   * Extract dominant brand colors from a store logo image using Gemini
   * Vision. Returns { primary, accent, neutral } as #RRGGBB hex strings.
   *
   * The caller (palette-from-logo route) already validates that the store
   * has a logo URL before calling this method. Throws AppError on:
   *   - Logo URL not reachable (fetch error)
   *   - Gemini returns non-JSON or invalid hex values
   *   - AI quota exhausted (re-thrown as AppError 429)
   */
  static async extractPaletteFromLogo(logoUrl: string, storeId: string): Promise<ExtractedPalette> {
    ensureEnabled();
    await assertAiQuota({ storeId });

    // Fetch the logo bytes — Gemini Vision needs inline base64 data.
    // SSRF guard: logoUrl is merchant-controlled — block private/loopback/
    // metadata targets before fetching server-side.
    let logoFetch: Response;
    try {
      logoFetch = await safeFetchImage(logoUrl);
    } catch {
      throw new AppError(502, 'AI_LOGO_FETCH_FAILED', 'Could not reach the logo URL.');
    }
    if (!logoFetch.ok) {
      throw new AppError(
        502,
        'AI_LOGO_FETCH_FAILED',
        `Logo fetch returned HTTP ${logoFetch.status}.`
      );
    }

    const arrayBuf = await logoFetch.arrayBuffer();
    const rawMime = (logoFetch.headers.get('content-type') ?? 'image/png')
      .split(';')[0]
      .trim()
      .toLowerCase();

    let base64: string;
    let mimeType: string;
    try {
      const rasterized = await rasterizeForGemini(Buffer.from(arrayBuf), rawMime);
      base64 = rasterized.data;
      mimeType = rasterized.mimeType;
    } catch (err) {
      logger.error({ err, rawMime, logoUrl }, 'Logo rasterization failed before Gemini call');
      throw new AppError(
        502,
        'AI_LOGO_RASTERIZE_FAILED',
        'Could not prepare the logo image for AI processing.'
      );
    }

    const prompt =
      'Look at this brand logo. Identify the 3 most important brand colors:\n' +
      '1. PRIMARY — the most dominant brand color (often the main shape/wordmark)\n' +
      '2. ACCENT — a complementary color that appears in the logo (or a harmonious accent if logo is single-color)\n' +
      '3. NEUTRAL — a background/surface color (white, cream, light gray — pick what complements primary)\n\n' +
      'Output ONLY a JSON object, no prose, no markdown fences:\n' +
      '{ "primary": "#RRGGBB", "accent": "#RRGGBB", "neutral": "#RRGGBB" }\n\n' +
      'Use 6-digit hex. Do not output any other text.';

    const model = getClient().getGenerativeModel({ model: MODEL });

    let res;
    try {
      res = await model.generateContent([
        {
          inlineData: {
            mimeType,
            data: base64,
          },
        },
        prompt,
      ]);
    } catch (err) {
      rethrowAsAppError(err, 'AI logo palette extraction failed');
    }

    const rawText = stripJsonFences(res.response.text());
    let parsed: ExtractedPalette;
    try {
      parsed = paletteExtractionSchema.parse(JSON.parse(rawText));
    } catch (err) {
      logger.error({ err, rawText }, 'Gemini returned invalid JSON for logo palette extraction');
      throw new AppError(
        502,
        'AI_BAD_RESPONSE',
        'AI returned an unexpected response for logo palette extraction.'
      );
    }

    const usage = res.response.usageMetadata;
    // Record as 'seo' feature bucket — no dedicated 'vision' bucket yet.
    // Token counts land in per-store quota tracking regardless.
    await recordUsage(
      storeId,
      'seo',
      usage?.promptTokenCount ?? 0,
      usage?.candidatesTokenCount ?? 0,
      false
    );

    return parsed;
  }

  /**
   * Suggest 1-3 categories for a product based on name + description.
   * Returns category objects matched against the store's existing
   * categories — never invents new ones.
   */
  static async suggestCategories(input: {
    storeId: string;
    productName: string;
    productDescription?: string | null;
    existingCategories: Array<{ id: string; name: string; nameAr: string | null }>;
  }): Promise<{ suggestions: CategorySuggestion[]; cached: boolean }> {
    ensureEnabled();
    if (input.existingCategories.length === 0) {
      return { suggestions: [], cached: false };
    }

    const key = cacheKey('categorize', {
      name: input.productName,
      desc: input.productDescription,
      catIds: input.existingCategories.map(c => c.id).sort(),
    });
    const hit = await redis.get(key);
    if (hit) {
      await recordUsage(input.storeId, 'categorize', 0, 0, true);
      return {
        suggestions: JSON.parse(hit) as CategorySuggestion[],
        cached: true,
      };
    }

    await assertAiQuota({ storeId: input.storeId });
    await checkBudget(input.storeId);

    const catList = input.existingCategories
      .map(c => `${c.id} :: ${c.name}${c.nameAr ? ` / ${c.nameAr}` : ''}`)
      .join('\n');

    const systemInstruction =
      'You categorise products for an Egyptian e-commerce store. Given a product ' +
      'name + description and a list of available categories, pick the 1-3 best ' +
      'matches. If none of the categories fit well, return an empty array. ' +
      'Output only valid JSON matching: {"matches": [{"id": string, ' +
      '"confidence": "high"|"medium"|"low"}]}. Use ONLY ids from the provided list.';

    const userPrompt = `Available categories (id :: name [/ name_ar]):\n${catList}\n\nProduct name: ${input.productName}\nProduct description: ${input.productDescription || '(none)'}`;

    const model = getClient().getGenerativeModel({
      model: MODEL,
      systemInstruction,
      generationConfig: { responseMimeType: 'application/json' },
    });
    let res;
    try {
      res = await model.generateContent(userPrompt);
    } catch (err) {
      rethrowAsAppError(err, 'AI categorisation failed');
    }
    const raw = stripJsonFences(res.response.text());

    const parsed = parseAiJson(categorizeSchema, raw, {
      storeId: input.storeId,
      kind: 'categorize',
    });

    const idSet = new Set(input.existingCategories.map(c => c.id));
    const suggestions: CategorySuggestion[] = parsed.matches
      .filter(m => idSet.has(m.id))
      .map(m => {
        const cat = input.existingCategories.find(c => c.id === m.id)!;
        return {
          id: cat.id,
          name: cat.name,
          nameAr: cat.nameAr,
          confidence: m.confidence,
        };
      });

    const usage = res.response.usageMetadata;
    await recordUsage(
      input.storeId,
      'categorize',
      usage?.promptTokenCount ?? 0,
      usage?.candidatesTokenCount ?? 0,
      false
    );

    await redis.set(key, JSON.stringify(suggestions), CACHE_TTL_SECONDS);
    return { suggestions, cached: false };
  }
}
