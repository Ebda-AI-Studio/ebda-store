import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { GeminiAnswerEngineProvider, type GeminiQueryModel } from '../gemini.provider';

function mockModel(generateContent: GeminiQueryModel['generateContent']): GeminiQueryModel {
  return { generateContent };
}

describe('GeminiAnswerEngineProvider', () => {
  beforeEach(() => {
    mockAssertAiQuota.mockReset().mockResolvedValue(undefined);
    mockRecordUsage.mockReset().mockResolvedValue(undefined);
  });

  it('parses citedUrls from grounding metadata on a mocked grounded response', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => 'Widget Co and Acme Widgets are both popular choices.',
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [] },
            groundingMetadata: {
              webSearchQueries: ['best widgets'],
              groundingChunks: [
                { web: { uri: 'https://widgetco.com/best-widgets', title: 'Widget Co' } },
                { web: { uri: 'https://acme-widgets.com', title: 'Acme Widgets' } },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 42,
          candidatesTokenCount: 18,
          totalTokenCount: 60,
        },
      },
    });

    const provider = new GeminiAnswerEngineProvider(mockModel(generateContent));
    const answer = await provider.query('store-1', 'who sells the best widgets?');

    expect(answer.citedUrls).toEqual([
      'https://widgetco.com/best-widgets',
      'https://acme-widgets.com',
    ]);
    expect(answer.grounded).toBe(true);
    expect(answer.text).toBe('Widget Co and Acme Widgets are both popular choices.');
  });

  it('calls assertAiQuota before querying and recordUsage with integer token counts after', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => 'answer',
        candidates: [{ index: 0, content: { role: 'model', parts: [] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    });

    const provider = new GeminiAnswerEngineProvider(mockModel(generateContent));
    await provider.query('store-42', 'prompt text');

    expect(mockAssertAiQuota).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).toHaveBeenCalledWith('store-42', 'answer_engine_gemini', 10, 5, false);

    // assertAiQuota must run before the model is actually called.
    const quotaOrder = mockAssertAiQuota.mock.invocationCallOrder[0];
    const genOrder = generateContent.mock.invocationCallOrder[0];
    expect(quotaOrder).toBeLessThan(genOrder);
  });

  it('marks grounded=false and returns an empty citedUrls list when the response carries no grounding metadata', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => 'an ungrounded answer',
        candidates: [{ index: 0, content: { role: 'model', parts: [] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      },
    });

    const provider = new GeminiAnswerEngineProvider(mockModel(generateContent));
    const answer = await provider.query('store-1', 'prompt');

    expect(answer.grounded).toBe(false);
    expect(answer.citedUrls).toEqual([]);
  });

  it('does not throw when text() throws (blocked candidate) and degrades to empty text', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => {
          throw new Error('blocked');
        },
        candidates: [],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0, totalTokenCount: 1 },
      },
    });

    const provider = new GeminiAnswerEngineProvider(mockModel(generateContent));
    await expect(provider.query('store-1', 'prompt')).resolves.toMatchObject({
      text: '',
      citedUrls: [],
      grounded: false,
    });
  });

  it('defaults missing usageMetadata token counts to 0 rather than throwing', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      response: {
        text: () => 'answer',
        candidates: [],
      },
    });

    const provider = new GeminiAnswerEngineProvider(mockModel(generateContent));
    await provider.query('store-9', 'prompt');

    expect(mockRecordUsage).toHaveBeenCalledWith('store-9', 'answer_engine_gemini', 0, 0, false);
  });
});
