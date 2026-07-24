import { describe, it, expect, vi, afterEach } from 'vitest';
import { PerplexityAnswerEngineProvider } from '../perplexity.provider';

describe('PerplexityAnswerEngineProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps a canned Sonar response to EngineAnswer: citedUrls from citations, text from message content, grounded=true', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'abc123',
        model: 'sonar',
        citations: ['https://widgetco.com/best-widgets', 'https://acme-widgets.com'],
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Widget Co and Acme Widgets are popular choices.',
            },
          },
        ],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const provider = new PerplexityAnswerEngineProvider('pplx-test-key');
    const answer = await provider.query('store-1', 'who sells the best widgets?');

    expect(answer.text).toBe('Widget Co and Acme Widgets are popular choices.');
    expect(answer.citedUrls).toEqual([
      'https://widgetco.com/best-widgets',
      'https://acme-widgets.com',
    ]);
    expect(answer.grounded).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.perplexity.ai/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer pplx-test-key');
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: 'who sells the best widgets?' }]);
  });

  it('degrades to a safe empty EngineAnswer (never throws) on a non-OK response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }) as unknown as typeof fetch;

    const provider = new PerplexityAnswerEngineProvider('bad-key');
    await expect(provider.query('store-1', 'prompt')).resolves.toEqual({
      text: '',
      citedUrls: [],
      grounded: false,
    });
  });

  it('degrades to a safe empty EngineAnswer when fetch itself throws (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const provider = new PerplexityAnswerEngineProvider('some-key');
    await expect(provider.query('store-1', 'prompt')).resolves.toEqual({
      text: '',
      citedUrls: [],
      grounded: false,
    });
  });

  it('defaults missing citations/message fields safely rather than throwing', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;

    const provider = new PerplexityAnswerEngineProvider('some-key');
    const answer = await provider.query('store-1', 'prompt');
    expect(answer).toMatchObject({ text: '', citedUrls: [], grounded: true });
  });

  it('degrades to a safe empty EngineAnswer when the response body is not valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('invalid json');
      },
    }) as unknown as typeof fetch;

    const provider = new PerplexityAnswerEngineProvider('some-key');
    await expect(provider.query('store-1', 'prompt')).resolves.toEqual({
      text: '',
      citedUrls: [],
      grounded: false,
    });
  });
});
