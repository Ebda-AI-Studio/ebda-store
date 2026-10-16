// Text embeddings for semantic product search (bge-m3 on Cloudflare Workers AI).
//
// Provider order: the Worker's `AI` binding, else the Workers AI REST API when BOTH
// `CF_AI_ACCOUNT_ID` and `CF_AI_API_TOKEN` are set (local Node dev / scripts only; the
// deployed Worker uses the binding), else none. "None" is never a stub that answers: callers
// get `null` and search stays lexical. `assertEmbeddingConfig` runs once at boot (worker.ts,
// index.ts) and refuses a configuration that asks for semantic search without a provider.
//
// Output shape measured 2026-10-16 on the Whisky account through the binding:
// `{ shape: [2, 1024], data: [[...1024], [...1024]], pooling: 'cls' }` for two texts.
import { cfBindings } from '../../cf/bindings';

export const EMBED_MODEL = '@cf/baai/bge-m3';
/** Must equal the `halfvec(N)` of `product_embeddings.embedding` (asserted by a unit test). */
export const EMBED_DIMS = 1024;
/** bge-m3 input schema: `text` array `maxItems: 100`. Larger inputs are split. */
export const EMBED_MAX_BATCH = 100;
/** Per call to Workers AI (binding or REST). Query-time callers race their own shorter budget. */
export const EMBED_TIMEOUT_MS = 15_000;

export interface EmbeddingProvider {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbeddingProviderKind = 'workers-ai' | 'rest' | 'none';

function check(data: unknown, n: number): number[][] {
  if (!Array.isArray(data) || data.length !== n)
    throw new Error(`embedding: expected ${n} vectors`);
  for (const v of data) {
    if (!Array.isArray(v) || v.length !== EMBED_DIMS)
      throw new Error(`embedding: expected ${EMBED_DIMS} dims`);
    for (const x of v) {
      if (typeof x !== 'number' || !Number.isFinite(x))
        throw new Error('embedding: non-finite component');
    }
  }
  return data as number[][];
}

async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${EMBED_TIMEOUT_MS} ms`)),
      EMBED_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Validates the input, splits it into model-sized batches, and keeps the output order. */
function batched(embedBatch: (texts: string[]) => Promise<number[][]>): EmbeddingProvider {
  return {
    model: EMBED_MODEL,
    async embed(texts) {
      if (texts.some(t => typeof t !== 'string' || t.trim() === ''))
        throw new Error('embedding: empty text (the model rejects it; skip the product instead)');
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_MAX_BATCH) {
        const chunk = texts.slice(i, i + EMBED_MAX_BATCH);
        out.push(...check(await embedBatch(chunk), chunk.length));
      }
      return out;
    },
  };
}

const bindingProvider = (): EmbeddingProvider | null => {
  const ai = cfBindings()?.AI;
  if (!ai) return null;
  return batched(async texts => {
    const out = (await withTimeout(
      ai.run(EMBED_MODEL, { text: texts }),
      'embedding (AI binding)'
    )) as { data?: unknown } | null;
    return out?.data as number[][];
  });
};

function restCredentials(): { acct: string; token: string } | null {
  const acct = process.env.CF_AI_ACCOUNT_ID;
  const token = process.env.CF_AI_API_TOKEN;
  return acct && token ? { acct, token } : null;
}

const restProvider = (): EmbeddingProvider | null => {
  const creds = restCredentials();
  if (!creds) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.acct)}/ai/run/${EMBED_MODEL}`;
  return batched(async texts => {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texts }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      }),
      'embedding REST'
    );
    // Status only: never echo the response body or the request (the token is in the header).
    if (!res.ok) throw new Error(`embedding REST ${res.status}`);
    const body = (await res.json()) as { success?: boolean; result?: { data?: unknown } };
    if (body.success === false) throw new Error('embedding REST success=false');
    return body.result?.data as number[][];
  });
};

let override: EmbeddingProvider | null | undefined;
/** Test seam: a fake provider, `null` for "no provider", `undefined` to resolve normally. */
export function setEmbeddingProviderForTests(p: EmbeddingProvider | null | undefined): void {
  override = p;
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (override !== undefined) return override;
  return bindingProvider() ?? restProvider();
}

export function semanticSearchEnabled(): boolean {
  return process.env.SEARCH_SEMANTIC_ENABLED === 'true' && getEmbeddingProvider() !== null;
}

export function toHalfvecLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function providerKind(): EmbeddingProviderKind {
  if (cfBindings()?.AI) return 'workers-ai';
  if (restCredentials()) return 'rest';
  return 'none';
}

/**
 * Boot check (fail loud, never a silent permissive fallback). Throws when:
 * - `SEARCH_SEMANTIC_ENABLED` is anything but unset / `true` / `false` (a typo is not "off");
 * - only one of `CF_AI_ACCOUNT_ID` / `CF_AI_API_TOKEN` is set;
 * - `SEARCH_SEMANTIC_ENABLED=true` and no provider resolves (no `AI` binding, no REST pair).
 * Otherwise logs the resolved provider once, including the explicit "none" when semantic
 * search is off, so the state is visible in the logs.
 */
export function assertEmbeddingConfig(log: { info: (obj: object, msg: string) => void }): {
  provider: EmbeddingProviderKind;
  semantic: boolean;
} {
  const flag = process.env.SEARCH_SEMANTIC_ENABLED;
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false')
    throw new Error(`SEARCH_SEMANTIC_ENABLED must be "true" or "false" (got "${flag}")`);
  const hasAcct = Boolean(process.env.CF_AI_ACCOUNT_ID);
  const hasToken = Boolean(process.env.CF_AI_API_TOKEN);
  if (hasAcct !== hasToken)
    throw new Error('CF_AI_ACCOUNT_ID and CF_AI_API_TOKEN must be set together (or neither)');
  const provider = providerKind();
  if (flag === 'true' && provider === 'none')
    throw new Error(
      'SEARCH_SEMANTIC_ENABLED=true but no embedding provider: bind Workers AI (`"ai": { "binding": "AI" }`) ' +
        'or set CF_AI_ACCOUNT_ID + CF_AI_API_TOKEN, or set SEARCH_SEMANTIC_ENABLED=false'
    );
  const semantic = flag === 'true';
  log.info(
    { provider, semantic, model: EMBED_MODEL },
    `[search] embedding provider: ${provider}; semantic search ${semantic ? 'ON' : 'OFF'}`
  );
  return { provider, semantic };
}
