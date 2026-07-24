import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAiAnswerEngineProvider } from '../openai.provider';

describe('OpenAiAnswerEngineProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps a canned grounded Responses-API reply: citedUrls from url_citation annotations, grounded=true', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'resp_abc',
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Widget Co is a popular choice for widgets.',
                annotations: [
                  {
                    type: 'url_citation',
                    start_index: 0,
                    end_index: 10,
                    url: 'https://widgetco.com/best-widgets',
                    title: 'Widget Co',
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const provider = new OpenAiAnswerEngineProvider('sk-test-key');
    const answer = await provider.query('store-1', 'who sells the best widgets?');

    expect(answer.text).toBe('Widget Co is a popular choice for widgets.');
    expect(answer.citedUrls).toEqual(['https://widgetco.com/best-widgets']);
    expect(answer.grounded).toBe(true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer sk-test-key');
    const body = JSON.parse(init.body as string);
    expect(body.input).toBe('who sells the best widgets?');
    expect(body.tools).toEqual([{ type: 'web_search_preview' }]);
  });

  it('marks grounded=false when no web_search_call output item is present (model answered without searching)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'resp_def',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Widget Co is generally well regarded.',
                annotations: [],
              },
            ],
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const provider = new OpenAiAnswerEngineProvider('sk-test-key');
    const answer = await provider.query('store-1', 'prompt');

    expect(answer.grounded).toBe(false);
    expect(answer.text).toBe('Widget Co is generally well regarded.');
    expect(answer.citedUrls).toEqual([]);
  });

  it('falls back to extracting bare URLs from text when no annotations are present', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'resp_ghi',
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'See https://widgetco.com/best-widgets for details.',
                annotations: [],
              },
            ],
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const provider = new OpenAiAnswerEngineProvider('sk-test-key');
    const answer = await provider.query('store-1', 'prompt');

    expect(answer.citedUrls).toEqual(['https://widgetco.com/best-widgets']);
  });

  it('degrades to a safe empty EngineAnswer (never throws) on a non-OK response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }) as unknown as typeof fetch;

    const provider = new OpenAiAnswerEngineProvider('bad-key');
    await expect(provider.query('store-1', 'prompt')).resolves.toEqual({
      text: '',
      citedUrls: [],
      grounded: false,
    });
  });

  it('degrades to a safe empty EngineAnswer when fetch itself throws (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const provider = new OpenAiAnswerEngineProvider('some-key');
    await expect(provider.query('store-1', 'prompt')).resolves.toEqual({
      text: '',
      citedUrls: [],
      grounded: false,
    });
  });

  it('defaults missing/malformed output fields safely rather than throwing', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;

    const provider = new OpenAiAnswerEngineProvider('some-key');
    const answer = await provider.query('store-1', 'prompt');
    expect(answer).toMatchObject({ text: '', citedUrls: [], grounded: false });
  });
});
