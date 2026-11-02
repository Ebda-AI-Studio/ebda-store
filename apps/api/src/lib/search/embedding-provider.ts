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
import { timedFetch } from '../fetch-with-timeout';

export const EMBED_MODEL = '@cf/baai/bge-m3';
/** Must equal the `halfvec(N)` of `product_embeddings.embedding` (asserted by a unit test). */
export const EMBED_DIMS = 1024;
/** bge-m3 input schema: `text` array `maxItems: 100`. Larger inputs are split. */
export const EMBED_MAX_BATCH = 100;
/** Per call to Workers AI (binding or REST); the call is aborted, not abandoned. Query-time callers pass their own shorter `signal`. */
export const EMBED_TIMEOUT_MS = 15_000;

export interface EmbedOptions {
  /** Caller cancellation (e.g. the query path's ~400 ms race, E11): aborts the in-flight call. */
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  model: string;
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

export type EmbeddingProviderKind = 'workers-ai' | 'rest' | 'test' | 'none';

export type EmbeddingErrorKind =
  | 'input' // an empty/whitespace text: fix the caller, never retry
  | 'shape' // wrong count, dims or a non-finite component: never retry
  | 'http' // REST non-2xx: `status` set; 429 and 5xx are retryable
  | 'network' // fetch itself failed (DNS, reset, a non-JSON proxy page)
  | 'provider' // the binding threw (capacity, internal), or REST answered success=false
  | 'timeout' // EMBED_TIMEOUT_MS elapsed; the call was aborted
  | 'aborted'; // the caller's signal fired; the call was aborted

/**
 * Every failure of `embed()` is one of these, so the indexer (Task 11) can retry or dead-letter and
 * the query path (Task 12) can log the fallback reason without matching message strings. Messages
 * never carry a response body or a credential.
 */
export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(
    kind: EmbeddingErrorKind,
    message: string,
    opts: { status?: number; retryable?: boolean } = {}
  ) {
    super(message);
    this.name = 'EmbeddingError';
    this.kind = kind;
    this.status = opts.status;
    this.retryable =
      opts.retryable ??
      (kind === 'timeout' ||
        kind === 'aborted' ||
        kind === 'network' ||
        (kind === 'http' &&
          opts.status !== undefined &&
          (opts.status === 429 || opts.status >= 500)));
  }
}

function check(data: unknown, n: number): number[][] {
  if (!Array.isArray(data) || data.length !== n)
    throw new EmbeddingError('shape', `embedding: expected ${n} vectors`);
  for (const v of data) {
    if (!Array.isArray(v) || v.length !== EMBED_DIMS)
      throw new EmbeddingError('shape', `embedding: expected ${EMBED_DIMS} dims`);
    for (const x of v) {
      if (typeof x !== 'number' || !Number.isFinite(x))
        throw new EmbeddingError('shape', 'embedding: non-finite component');
    }
  }
  return data as number[][];
}

/**
 * Runs one provider call under a signal that fires on the caller's abort OR after
 * EMBED_TIMEOUT_MS, and passes that signal to the call so it is CANCELLED, not just abandoned.
 * Also rejects as soon as the signal fires, even if the call ignores it.
 */
async function cancellable<T>(
  label: string,
  caller: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
  callFailed: EmbeddingErrorKind
): Promise<T> {
  const abortError = () =>
    caller?.aborted
      ? new EmbeddingError('aborted', `${label} aborted by the caller`)
      : new EmbeddingError('timeout', `${label} timed out after ${EMBED_TIMEOUT_MS} ms`);
  if (caller?.aborted) throw abortError();
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), EMBED_TIMEOUT_MS);
  const signal = caller ? AbortSignal.any([caller, timeoutCtl.signal]) : timeoutCtl.signal;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([call(signal), aborted]);
  } catch (err) {
    if (err instanceof EmbeddingError) throw err;
    if (signal.aborted) throw abortError();
    // The underlying message is not forwarded: a provider error could echo input text.
    throw new EmbeddingError(callFailed, `${label} failed (${(err as Error)?.name ?? 'Error'})`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Validates the input, splits it into model-sized batches, and keeps the output order. */
function batched(
  embedBatch: (texts: string[], signal: AbortSignal) => Promise<number[][]>,
  label: string,
  callFailed: EmbeddingErrorKind
): EmbeddingProvider {
  return {
    model: EMBED_MODEL,
    async embed(texts, opts) {
      if (texts.some(t => typeof t !== 'string' || t.trim() === ''))
        throw new EmbeddingError(
          'input',
          'embedding: empty text (the model rejects it; skip the product instead)'
        );
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_MAX_BATCH) {
        const chunk = texts.slice(i, i + EMBED_MAX_BATCH);
        const data = await cancellable(
          label,
          opts?.signal,
          signal => embedBatch(chunk, signal),
          callFailed
        );
        out.push(...check(data, chunk.length));
      }
      return out;
    },
  };
}

const bindingProvider = (): EmbeddingProvider | null => {
  const ai = cfBindings()?.AI;
  if (!ai) return null;
  return batched(
    async (texts, signal) => {
      const out = (await ai.run(EMBED_MODEL, { text: texts }, { signal })) as {
        data?: unknown;
      } | null;
      return out?.data as number[][];
    },
    'embedding (AI binding)',
    'provider'
  );
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
  return batched(
    async (texts, signal) => {
      const res = await timedFetch('embedding', 'ai')(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texts }),
        signal,
      });
      // Status only: never echo the response body or the request (the token is in the header).
      if (!res.ok)
        throw new EmbeddingError('http', `embedding REST ${res.status}`, { status: res.status });
      let body: { success?: boolean; result?: { data?: unknown } } | null;
      try {
        body = JSON.parse(await res.text());
      } catch {
        // JSON.parse's message quotes the start of the body (a proxy/captive page): never echo it.
        throw new EmbeddingError('network', 'embedding REST: non-JSON body');
      }
      if (body?.success === false)
        throw new EmbeddingError('provider', 'embedding REST success=false', { retryable: false });
      return body?.result?.data as number[][];
    },
    'embedding REST',
    'network'
  );
};

let override: EmbeddingProvider | null | undefined;
/** Test seam: a fake provider, `null` for "no provider", `undefined` to resolve normally. */
export function setEmbeddingProviderForTests(p: EmbeddingProvider | null | undefined): void {
  override = p;
}

/** The ONE resolution order; the boot check's log and every caller read it from here. */
function resolveEmbeddingProvider(): {
  kind: EmbeddingProviderKind;
  provider: EmbeddingProvider | null;
} {
  if (override !== undefined) return { kind: override ? 'test' : 'none', provider: override };
  const binding = bindingProvider();
  if (binding) return { kind: 'workers-ai', provider: binding };
  const rest = restProvider();
  if (rest) return { kind: 'rest', provider: rest };
  return { kind: 'none', provider: null };
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  return resolveEmbeddingProvider().provider;
}

export function semanticSearchEnabled(): boolean {
  return process.env.SEARCH_SEMANTIC_ENABLED === 'true' && getEmbeddingProvider() !== null;
}

/** `[x,y,...]` for a `::halfvec` parameter; refuses a wrong length or NaN/Infinity before SQL. */
export function toHalfvecLiteral(v: number[]): string {
  check([v], 1);
  return `[${v.join(',')}]`;
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
  const provider = resolveEmbeddingProvider().kind;
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
