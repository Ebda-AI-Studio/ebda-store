/**
 * Answer-engine provider config service (AEO/GEO insights feature, Task 5).
 *
 * Owns the WRITE side of `AnswerEngineProviderConfig` — the encrypted
 * API key + enabled toggle for the paid opt-in engines (Perplexity, OpenAI).
 * Gemini is deliberately excluded: it runs on the platform's own key and has
 * no config row (see registry.ts).
 *
 * Secret-handling discipline mirrors `payment-settings.routes.ts` exactly:
 *   - Encrypt on write: `encryption.encrypt(plaintext)` before it ever
 *     touches the DB.
 *   - Mask on read: the value returned to the admin is
 *     `encryption.mask(<stored, still-encrypted value>)` — the SAME thing
 *     `maskCredentials` does for PaymentConfig. This never decrypts on a
 *     read path at all, so a GET can never leak plaintext even indirectly.
 *   - Don't-clobber-on-masked-value: if the incoming `apiKey` still
 *     contains the `****` mask sentinel (i.e. the admin UI round-tripped an
 *     untouched masked field), the stored key is left completely alone —
 *     only `enabled` is updated. This is the same discipline as
 *     `payment-settings.routes.ts`'s PUT handler and
 *     `preserveMaskedPixelSecrets`.
 *
 * This module NEVER decrypts. Only `registry.ts` (Task 4) ever calls
 * `encryption.decrypt` on these rows, at the moment a provider is actually
 * constructed for a check run.
 */
import { prisma } from '@force/database';
import { encryption } from '../encryption.service';

// The only two engines that carry a config row. Gemini uses the platform
// key and is intentionally never a member of this list — see registry.ts.
export const PAID_ANSWER_ENGINES = ['perplexity', 'openai'] as const;
export type PaidAnswerEngine = (typeof PAID_ANSWER_ENGINES)[number];

export function isPaidAnswerEngine(value: string): value is PaidAnswerEngine {
  return (PAID_ANSWER_ENGINES as readonly string[]).includes(value);
}

export interface ProviderConfigView {
  engine: PaidAnswerEngine;
  enabled: boolean;
  /** Masked display value, e.g. `sk_a****1234`. `null` when no key is stored. */
  apiKeyMasked: string | null;
}

export interface UpsertProviderConfigInput {
  /**
   * A new plaintext key to store, OR the previously-masked value
   * round-tripped unchanged by the client. Omit entirely to leave the
   * stored key untouched while only flipping `enabled`.
   */
  apiKey?: string;
  enabled?: boolean;
}

const MASK_SENTINEL = '****';

function isMaskedSentinel(value: string): boolean {
  return value.includes(MASK_SENTINEL);
}

/**
 * Returns every paid engine's config, masked for safe display. Engines with
 * no row yet (never configured) come back with `enabled: false` and
 * `apiKeyMasked: null` so the admin UI always has one entry per engine.
 */
export async function getProviderConfigs(): Promise<ProviderConfigView[]> {
  const rows = await prisma.answerEngineProviderConfig.findMany({
    where: { engine: { in: [...PAID_ANSWER_ENGINES] } },
  });
  const byEngine = new Map(rows.map(row => [row.engine, row]));

  return PAID_ANSWER_ENGINES.map(engine => {
    const row = byEngine.get(engine);
    return {
      engine,
      enabled: row?.enabled ?? false,
      apiKeyMasked: row?.apiKey ? encryption.mask(row.apiKey) : null,
    };
  });
}

/**
 * Upsert a single engine's config. Encrypts a genuinely-new key; leaves the
 * stored key untouched if the incoming `apiKey` is the masked sentinel
 * round-tripped from a prior GET. Throws for any engine that isn't one of
 * the allowed paid engines.
 */
export async function upsertProviderConfig(
  engine: string,
  input: UpsertProviderConfigInput
): Promise<ProviderConfigView> {
  if (!isPaidAnswerEngine(engine)) {
    throw new Error(`Unsupported answer-engine provider: ${engine}`);
  }

  const data: { apiKey?: string; enabled?: boolean } = {};

  if (input.apiKey !== undefined) {
    if (isMaskedSentinel(input.apiKey)) {
      // Masked value round-tripped unchanged — do NOT overwrite the stored
      // secret with mask text. Simply omit apiKey from the update.
    } else {
      data.apiKey = encryption.encrypt(input.apiKey);
    }
  }

  if (input.enabled !== undefined) {
    data.enabled = input.enabled;
  }

  const row = await prisma.answerEngineProviderConfig.upsert({
    where: { engine },
    create: {
      engine,
      apiKey: data.apiKey ?? null,
      enabled: data.enabled ?? false,
    },
    update: data,
  });

  return {
    engine,
    enabled: row.enabled,
    apiKeyMasked: row.apiKey ? encryption.mask(row.apiKey) : null,
  };
}
