/**
 * Answer-engine provider registry (AEO/GEO insights feature).
 *
 * `getEnabledProviders` is the single place that decides which engines a
 * given check run queries:
 *   - Gemini is ALWAYS included — it runs on the platform's own key
 *     (`config.googleAiKey`), no per-store/per-admin configuration needed.
 *   - Perplexity/OpenAI are ADDITIONAL, opt-in engines. Each row in
 *     `AnswerEngineProviderConfig` is a merchant-independent, platform-wide
 *     toggle (Task 5 builds the admin UI that writes `enabled`/`apiKey`);
 *     a row is only turned into a live provider when BOTH `enabled` is
 *     true AND `apiKey` is set — a disabled or keyless row is silently
 *     excluded, never constructed.
 *
 * This is the ONLY place that decrypts provider API keys. Adapters
 * always receive an already-decrypted key at construction — they never
 * touch the encryption service themselves. Decryption failure (corrupt
 * ciphertext, wrong ENCRYPTION_KEY, etc.) degrades to skipping that one
 * row rather than failing the whole registry lookup — a single bad
 * config row must not take down every engine's insight check.
 */
import { prisma } from '@ebda/database';
import { encryption } from '../encryption.service';
import logger from '../../lib/logger';
import { GeminiAnswerEngineProvider } from './gemini.provider';
import { PerplexityAnswerEngineProvider } from './perplexity.provider';
import { OpenAiAnswerEngineProvider } from './openai.provider';
import type { AnswerEngineProvider } from './provider';

type EngineBuilder = (apiKey: string) => AnswerEngineProvider;

// Engines that require an admin-configured key. Gemini deliberately has
// no entry here — it's constructed unconditionally below.
const KEYED_ENGINE_BUILDERS: Record<string, EngineBuilder> = {
  perplexity: apiKey => new PerplexityAnswerEngineProvider(apiKey),
  openai: apiKey => new OpenAiAnswerEngineProvider(apiKey),
};

export async function getEnabledProviders(): Promise<AnswerEngineProvider[]> {
  const providers: AnswerEngineProvider[] = [new GeminiAnswerEngineProvider()];

  const rows = await prisma.answerEngineProviderConfig.findMany();

  for (const row of rows) {
    if (!row.enabled || !row.apiKey) continue;

    const build = KEYED_ENGINE_BUILDERS[row.engine];
    if (!build) {
      logger.warn({ engine: row.engine }, 'Unknown answer-engine provider config row; skipping');
      continue;
    }

    let apiKey: string;
    try {
      apiKey = encryption.decrypt(row.apiKey);
    } catch (err) {
      logger.error(
        { err, engine: row.engine },
        'Failed to decrypt answer-engine provider key; skipping'
      );
      continue;
    }
    if (!apiKey) continue;

    providers.push(build(apiKey));
  }

  return providers;
}
