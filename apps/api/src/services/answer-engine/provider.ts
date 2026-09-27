/**
 * Answer-engine provider abstraction (AEO/GEO insights feature).
 *
 * Each provider (Gemini, and later Perplexity/OpenAI in Task 4) answers a
 * representative shopper prompt for a store and reports whether the store
 * was cited in the answer. `detectCitation` is the shared, provider-agnostic
 * parsing logic that turns a raw `EngineAnswer` into a citation verdict.
 *
 * Untrusted input: `EngineAnswer` comes from a third-party LLM response
 * (sometimes grounded web search results, sometimes free-text). Every field
 * is treated as attacker/garbage-controlled — `detectCitation` MUST NOT
 * throw on malformed, missing, or unexpected-shape input.
 */

export interface AnswerEngineProvider {
  engine: string;
  /**
   * The model id this provider actually calls. Recorded as usage provenance
   * so cost is priced at the invoked model's rate, not `GEMINI_MODEL`'s
   * (#1038). Optional only so test doubles can omit it.
   */
  modelId?: string;
  query(storeId: string, prompt: string): Promise<EngineAnswer>;
}

export type EngineAnswer = {
  text: string;
  citedUrls: string[];
  /**
   * True when the underlying provider actually performed grounded/live web
   * retrieval for this answer. False (or undefined) means the answer is
   * ungrounded model knowledge — the dashboard should caveat the signal.
   */
  grounded?: boolean;
  /**
   * Set (by `gemini.provider.ts` only, so far) when a grounded call was
   * attempted but the model/key combination couldn't perform it right now
   * (a retired alias, a rejected tool shape, or a quota limit — HTTP
   * 400/404/429) and the provider fell back to an ungrounded call rather
   * than failing the scan. A short machine-readable tag, e.g. `'http_429'`
   * — distinct from a plain `grounded: false`, which also covers "grounding
   * ran fine but found nothing to cite". Persisted so the dashboard can
   * show "search grounding unavailable" instead of the generic caveat.
   */
  groundingUnavailableReason?: string;
  raw?: unknown;
};

export type CitationResult = {
  cited: boolean;
  rank?: number;
  snippet?: string;
  competitorUrls: string[];
};

const SNIPPET_MAX_LENGTH = 280;

/**
 * Normalize a domain or URL string to a bare, lowercase host with any
 * leading `www.` stripped — e.g. `"https://WWW.Example.com/x"` and
 * `"example.com"` both normalize to `"example.com"`. Returns null for
 * anything that isn't a usable host (empty, non-string, unparsable).
 */
function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    const stripped = host.replace(/^www\./, '');
    return stripped || null;
  } catch {
    return null;
  }
}

/**
 * Determine whether `answer` cites the store, which competitor hosts also
 * showed up, and (if cited via a URL) the store's 1-based rank among the
 * cited URLs. Defensive against malformed/empty input by design — this
 * parses untrusted third-party LLM output.
 */
export function detectCitation(
  store: { domain: string | null; brand?: string } | null | undefined,
  answer: EngineAnswer | null | undefined
): CitationResult {
  const empty: CitationResult = { cited: false, competitorUrls: [] };
  if (!answer || typeof answer !== 'object') return empty;

  const storeHost = store && typeof store === 'object' ? normalizeHost(store.domain) : null;
  const rawCitedUrls = Array.isArray(answer.citedUrls) ? answer.citedUrls : [];
  const answerText = typeof answer.text === 'string' ? answer.text : '';

  // Normalize every cited entry, keeping the original string + position so
  // rank reflects the provider's actual ordering and competitorUrls keeps
  // the original (non-normalized) URL string for display.
  const normalized = rawCitedUrls
    .map(raw => ({ raw, host: normalizeHost(raw) }))
    .filter((entry): entry is { raw: string; host: string } => entry.host !== null);

  let cited = false;
  let rank: number | undefined;

  if (storeHost) {
    const idx = normalized.findIndex(entry => entry.host === storeHost);
    if (idx >= 0) {
      cited = true;
      rank = idx + 1;
    }
  }

  const brand = store && typeof store.brand === 'string' ? store.brand.trim() : '';
  if (!cited && brand && answerText.toLowerCase().includes(brand.toLowerCase())) {
    cited = true;
  }

  const seen = new Set<string>();
  const competitorUrls = normalized
    .filter(entry => entry.host !== storeHost)
    .map(entry => entry.raw)
    .filter(raw => {
      if (seen.has(raw)) return false;
      seen.add(raw);
      return true;
    });

  const snippet = cited && answerText ? answerText.slice(0, SNIPPET_MAX_LENGTH) : undefined;

  return {
    cited,
    ...(rank !== undefined ? { rank } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    competitorUrls,
  };
}
