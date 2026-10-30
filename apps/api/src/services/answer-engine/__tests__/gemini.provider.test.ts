import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks -------------------------------------------------------------
// The adapter must go through the platform request-cap guard and the
// shared usage recorder rather than calling Gemini or writing usage rows
// directly. Mock both so the test asserts they were invoked with the
// right arguments, without touching a real DB or the real Gemini API.
const { mockAssertAiQuota, mockRecordUsage } = vi.hoisted(() => ({
  mockAssertAiQuota: vi.fn(),
  mockRecordUsage: vi.fn(),
}));

vi.mock('../../../lib/ai-quota', () => ({
  assertAiQuota: mockAssertAiQuota,
}));

vi.mock('../../ai.service', () => ({
  recordUsage: mockRecordUsage,
}));

// The adapter reads `config.googleAiKey` and throws AI_NOT_CONFIGURED when
// unset — mock it to a fixed test key so these tests exercise the real
// Gemini-call path instead of that guard (a real deployment always has this
// set; `registry.test.ts` covers the guard itself indirectly via the
// constructor's real config read).
vi.mock('../../../config', () => ({
  config: { googleAiKey: 'test-gemini-key' },
}));

import logger from '../../../lib/logger';
import { resetGeminiKeyState } from '../../../lib/ai/gemini-keys';
import { GeminiAnswerEngineProvider, resetGeminiGroundingWarnOnce } from '../gemini.provider';

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  };
}

describe('GeminiAnswerEngineProvider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockAssertAiQuota.mockReset().mockResolvedValue(undefined);
    mockRecordUsage.mockReset().mockResolvedValue(undefined);
    resetGeminiGroundingWarnOnce();
    resetGeminiKeyState();
    // One key only (the mocked config key): a developer shell's real GEMINI_API_KEY* would
    // otherwise add failover keys and change how many fetches a 429 produces.
    for (const k of [
      'GOOGLE_GENERATIVE_AI_KEY',
      'GEMINI_API_KEY',
      'GEMINI_API_KEY_2',
      'GEMINI_API_KEY_3',
    ]) {
      vi.stubEnv(k, '');
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('parses citedUrls from a grounded response and sets grounded=true', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Widget Co and Acme Widgets are both popular choices.' }],
            },
            groundingMetadata: {
              webSearchQueries: ['best widgets'],
              groundingChunks: [
                { web: { uri: 'https://widgetco.com/best-widgets', title: 'Widget Co' } },
                { web: { uri: 'https://acme-widgets.com', title: 'Acme Widgets' } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 18, totalTokenCount: 60 },
      })
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    const answer = await provider.query('store-1', 'who sells the best widgets?');

    expect(answer.citedUrls).toEqual([
      'https://widgetco.com/best-widgets',
      'https://acme-widgets.com',
    ]);
    expect(answer.grounded).toBe(true);
    expect(answer.groundingUnavailableReason).toBeUndefined();
    expect(answer.text).toBe('Widget Co and Acme Widgets are both popular choices.');

    // Exactly one call — the grounded call succeeded, no fallback needed.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends the current google_search tool, never the legacy googleSearchRetrieval shape (regression guard)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      })
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    await provider.query('store-1', 'prompt text');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(GEMINI_URL);
    expect(init.headers['x-goog-api-key']).toBeDefined();

    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    // Regression guard: the legacy tool must never come back.
    expect(JSON.stringify(body)).not.toContain('googleSearchRetrieval');
  });

  it('calls assertAiQuota before querying and recordUsage with integer token counts after', async () => {
    const generateContent = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      })
    );
    global.fetch = generateContent as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    await provider.query('store-42', 'prompt text');

    expect(mockAssertAiQuota).toHaveBeenCalledTimes(1);
    // The 6th arg carries the model actually invoked, so the usage row is
    // priced at ANSWER_ENGINE_GEMINI_MODEL's rate rather than GEMINI_MODEL's
    // (#1038).
    expect(mockRecordUsage).toHaveBeenCalledWith('store-42', 'answer_engine_gemini', 10, 5, false, {
      model: 'gemini-2.5-flash-lite',
    });
    expect(provider.modelId).toBe('gemini-2.5-flash-lite');

    // assertAiQuota must run before the model is actually called.
    const quotaOrder = mockAssertAiQuota.mock.invocationCallOrder[0];
    const genOrder = generateContent.mock.invocationCallOrder[0];
    expect(quotaOrder).toBeLessThan(genOrder);
  });

  it('marks grounded=false and returns an empty citedUrls list when the response carries no grounding metadata', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'an ungrounded answer' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      })
    ) as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    const answer = await provider.query('store-1', 'prompt');

    expect(answer.grounded).toBe(false);
    expect(answer.citedUrls).toEqual([]);
    expect(answer.groundingUnavailableReason).toBeUndefined();
  });

  it('degrades to empty text without throwing when the response has no parts (blocked candidate)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        candidates: [{ finishReason: 'SAFETY' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0, totalTokenCount: 1 },
      })
    ) as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    await expect(provider.query('store-1', 'prompt')).resolves.toMatchObject({
      text: '',
      citedUrls: [],
      grounded: false,
    });
  });

  it('defaults missing usageMetadata token counts to 0 rather than throwing', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'answer' }] } }] })
      ) as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    await provider.query('store-9', 'prompt');

    expect(mockRecordUsage).toHaveBeenCalledWith('store-9', 'answer_engine_gemini', 0, 0, false, {
      model: 'gemini-2.5-flash-lite',
    });
  });

  it('falls back to an ungrounded call on HTTP 429 (quota) and records a groundingUnavailableReason', async () => {
    const mockFetch = vi
      .fn()
      // First call: grounded, quota-limited.
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { message: 'exceeded your current quota' } })
      )
      // Second call: ungrounded fallback, succeeds.
      .mockResolvedValueOnce(
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: 'an ungrounded fallback answer' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 },
        })
      );
    global.fetch = mockFetch as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    const answer = await provider.query('store-1', 'prompt');

    expect(answer.grounded).toBe(false);
    expect(answer.groundingUnavailableReason).toBe('http_429');
    expect(answer.citedUrls).toEqual([]);
    expect(answer.text).toBe('an ungrounded fallback answer');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.tools).toEqual([{ google_search: {} }]);
    expect(secondBody.tools).toBeUndefined();

    // The scan still gets a usable answer written — never a thrown error.
    expect(mockRecordUsage).toHaveBeenCalledWith('store-1', 'answer_engine_gemini', 5, 6, false, {
      model: 'gemini-2.5-flash-lite',
    });
  });

  it('falls back on HTTP 400 (legacy tool rejected) and on HTTP 404 (retired model)', async () => {
    for (const status of [400, 404]) {
      mockRecordUsage.mockClear();
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(status, { error: { message: `simulated ${status}` } }))
        .mockResolvedValueOnce(
          jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'fallback' }] } }] })
        );
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new GeminiAnswerEngineProvider();
      const answer = await provider.query('store-1', 'prompt');

      expect(answer.groundingUnavailableReason).toBe(`http_${status}`);
      expect(answer.grounded).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }
  });

  it('logs the grounding-unavailable warning once per scan (until reset), not once per query', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.tools) return jsonResponse(429, { error: { message: 'quota' } });
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }) as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    await provider.query('store-1', 'prompt one');
    await provider.query('store-1', 'prompt two');
    await provider.query('store-1', 'prompt three');

    // Count only the grounding-unavailable warning; key-failover warnings are separate.
    const groundingWarns = warnSpy.mock.calls.filter(
      c => typeof c[1] === 'string' && c[1].includes('search grounding unavailable')
    );
    expect(groundingWarns).toHaveLength(1);
  });

  it('a grounded 429 benches only grounded calls: later queries still get the ungrounded answer (B0-51)', async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.tools) return jsonResponse(429, { error: { message: 'quota' } });
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'plain' }] } }] });
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    const first = await provider.query('store-1', 'one');
    const second = await provider.query('store-1', 'two');

    expect(first.text).toBe('plain');
    expect(second.text).toBe('plain');
    expect(second.groundingUnavailableReason).toBe('http_429');
    // Query two skips Google for the benched grounded call and goes straight to the plain call.
    const toolCalls = mockFetch.mock.calls.filter(
      c => JSON.parse((c[1] as RequestInit).body as string).tools
    );
    expect(toolCalls).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('every key 429s on the grounded call: tries each key, then answers ungrounded (GEM-4)', async () => {
    vi.stubEnv('GEMINI_API_KEY_2', 'second-key');
    const keysByCall: Array<{ key: string; grounded: boolean }> = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const key = (init.headers as Record<string, string>)['x-goog-api-key'];
      keysByCall.push({ key, grounded: Boolean(body.tools) });
      if (body.tools) return jsonResponse(429, { error: { message: 'quota' } });
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'plain' }] } }] });
    }) as unknown as typeof fetch;

    const answer = await new GeminiAnswerEngineProvider().query('store-1', 'prompt');

    expect(answer.text).toBe('plain');
    expect(answer.grounded).toBe(false);
    expect(answer.groundingUnavailableReason).toBe('http_429');
    expect(keysByCall.filter(c => c.grounded).map(c => c.key)).toEqual([
      'test-gemini-key',
      'second-key',
    ]);
    expect(keysByCall.filter(c => !c.grounded)).toHaveLength(1);
  });

  it('every key 429s on the plain call too: fails with 502 GEMINI_API_ERROR, no further degrade (GEM-4)', async () => {
    vi.stubEnv('GEMINI_API_KEY_2', 'second-key');
    const mockFetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse(429, { error: { message: 'quota' } }));
    global.fetch = mockFetch as unknown as typeof fetch;

    await expect(new GeminiAnswerEngineProvider().query('store-1', 'prompt')).rejects.toMatchObject(
      { statusCode: 502, code: 'GEMINI_API_ERROR' }
    );
    // 2 grounded attempts + 2 plain attempts; nothing recorded as usage.
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('propagates a real error (non-grounding-unavailable status) rather than silently degrading', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(500, { error: { message: 'internal error' } })
      ) as unknown as typeof fetch;

    const provider = new GeminiAnswerEngineProvider();
    await expect(provider.query('store-1', 'prompt')).rejects.toThrow();
  });

  it('defaults to the free, verified-grounding model (gemini-2.5-flash-lite) and is overridable via env', async () => {
    vi.resetModules();
    const originalEnv = process.env.ANSWER_ENGINE_GEMINI_MODEL;
    try {
      delete process.env.ANSWER_ENGINE_GEMINI_MODEL;
      const { GeminiAnswerEngineProvider: DefaultProvider } = await import('../gemini.provider.js');
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] })
        );
      global.fetch = mockFetch as unknown as typeof fetch;
      await new DefaultProvider().query('store-1', 'prompt');
      expect(mockFetch.mock.calls[0][0] as string).toContain('/models/gemini-2.5-flash-lite:');

      vi.resetModules();
      process.env.ANSWER_ENGINE_GEMINI_MODEL = 'gemini-custom-model';
      const { GeminiAnswerEngineProvider: OverriddenProvider } =
        await import('../gemini.provider.js');
      const mockFetch2 = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'x' }] } }] })
        );
      global.fetch = mockFetch2 as unknown as typeof fetch;
      mockRecordUsage.mockClear();
      await new OverriddenProvider().query('store-1', 'prompt');
      // #1038: usage is priced at the model actually called, not GEMINI_MODEL's.
      expect(mockRecordUsage.mock.calls[0]?.[5]).toEqual({ model: 'gemini-custom-model' });
      expect(mockFetch2.mock.calls[0][0] as string).toContain('/models/gemini-custom-model:');
    } finally {
      if (originalEnv === undefined) delete process.env.ANSWER_ENGINE_GEMINI_MODEL;
      else process.env.ANSWER_ENGINE_GEMINI_MODEL = originalEnv;
      vi.resetModules();
    }
  });
});
