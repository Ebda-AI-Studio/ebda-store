/**
 * Force Store AI assistant — translation, SEO meta, category suggestions.
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
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createHash } from 'crypto';
import { prisma } from '@force/database';
import { config } from '../config';
import { redis } from './redis.service';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';

type Feature = 'translate' | 'seo' | 'categorize';
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

// Free-tier eligible model. `gemini-2.0-flash` requires paid billing
// on most accounts as of 2026; `gemini-1.5-flash` stays in the free
// tier (15 req/min, 1500 req/day). Override via env to upgrade.
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const META_TITLE_MAX = 60;
const META_DESCRIPTION_MAX = 160;

let cachedClient: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI {
  if (!config.googleAiKey) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI features are not configured on this server.');
  }
  if (!cachedClient) cachedClient = new GoogleGenerativeAI(config.googleAiKey);
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

async function recordUsage(
  storeId: string,
  feature: Feature,
  inputTokens: number,
  outputTokens: number,
  cachedHit: boolean
): Promise<void> {
  try {
    await prisma.aiUsage.create({
      data: { storeId, feature, inputTokens, outputTokens, cachedHit },
    });
  } catch (err) {
    // Never fail the user-facing request because we couldn't log usage.
    logger.warn({ err, storeId, feature }, 'Failed to record AI usage');
  }
}

/**
 * Translate Google Generative AI SDK errors into AppError so the
 * Express error handler can return a useful HTTP status + message
 * to the merchant instead of a generic 500.
 */
function rethrowAsAppError(err: unknown, fallback: string): never {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429) {
    throw new AppError(
      429,
      'AI_QUOTA_EXCEEDED',
      'AI quota reached for this minute or day. Try again shortly, or contact support to raise the limit.'
    );
  }
  if (e?.status === 401 || e?.status === 403) {
    throw new AppError(
      503,
      'AI_NOT_CONFIGURED',
      'AI features are misconfigured on this server (auth failed). Contact support.'
    );
  }
  if (e?.status === 400) {
    throw new AppError(
      502,
      'AI_BAD_REQUEST',
      e.message?.slice(0, 240) || 'AI rejected the request shape.'
    );
  }
  logger.error({ err }, fallback);
  throw new AppError(502, 'AI_UPSTREAM_ERROR', fallback);
}

/**
 * Strip Markdown code fences that Gemini sometimes wraps JSON in even
 * when responseMimeType is set. Defensive — most calls don't need it.
 */
function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

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

    const key = cacheKey('translate', {
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

    await checkBudget(input.storeId);

    const lengthHint =
      input.kind === 'meta-title'
        ? ` Stay under ${META_TITLE_MAX} characters.`
        : input.kind === 'meta-description'
          ? ` Stay under ${META_DESCRIPTION_MAX} characters.`
          : '';

    const systemInstruction =
      'You translate Kuwaiti e-commerce content between English and Arabic. ' +
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

    await checkBudget(input.storeId);

    const systemInstruction =
      'You write SEO meta for Kuwaiti e-commerce stores. Output only valid JSON ' +
      'matching this shape exactly: {"title": string, "titleAr": string, ' +
      '"description": string, "descriptionAr": string, "keywords": string[]}. ' +
      `Title under ${META_TITLE_MAX} characters. Description under ${META_DESCRIPTION_MAX} characters. ` +
      'Keywords: 5-10 short Kuwait + GCC search phrases. Do not mention prices ' +
      'or out-of-stock status. Match how Kuwaiti shoppers actually search.';

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

    let parsed: SeoSuggestion;
    try {
      parsed = JSON.parse(raw) as SeoSuggestion;
    } catch (err) {
      logger.error({ err, raw, storeId: input.storeId }, 'Gemini returned non-JSON for SEO');
      throw new AppError(502, 'AI_BAD_RESPONSE', 'AI returned an unexpected response format.');
    }

    // Defensive validation — Gemini occasionally drops a field
    if (
      typeof parsed.title !== 'string' ||
      typeof parsed.titleAr !== 'string' ||
      typeof parsed.description !== 'string' ||
      typeof parsed.descriptionAr !== 'string' ||
      !Array.isArray(parsed.keywords)
    ) {
      throw new AppError(502, 'AI_BAD_RESPONSE', 'AI returned an incomplete SEO suggestion.');
    }

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

    await checkBudget(input.storeId);

    const catList = input.existingCategories
      .map(c => `${c.id} :: ${c.name}${c.nameAr ? ` / ${c.nameAr}` : ''}`)
      .join('\n');

    const systemInstruction =
      'You categorise products for a Kuwaiti e-commerce store. Given a product ' +
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

    let parsed: { matches: Array<{ id: string; confidence: 'high' | 'medium' | 'low' }> };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.error({ err, raw, storeId: input.storeId }, 'Gemini returned non-JSON for categorize');
      throw new AppError(502, 'AI_BAD_RESPONSE', 'AI returned an unexpected response format.');
    }

    const idSet = new Set(input.existingCategories.map(c => c.id));
    const suggestions: CategorySuggestion[] = (parsed.matches || [])
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
