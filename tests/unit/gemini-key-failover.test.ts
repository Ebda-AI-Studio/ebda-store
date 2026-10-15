/**
 * Gemini key failover (Ruling GEMINI-FAILOVER-1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  calls: [] as string[],
  behaviour: new Map<string, () => unknown>(),
}));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    constructor(private key: string) {}
    getGenerativeModel() {
      return {
        generateContent: async () => {
          sdk.calls.push(this.key);
          return sdk.behaviour.get(this.key)!();
        },
      };
    }
  },
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@api/lib/logger', () => ({ default: log }));

import {
  GeminiFailoverClient,
  getGeminiKeys,
  resetGeminiKeyState,
  cooldownFor,
  withGeminiFailover,
} from '@api/lib/ai/gemini-keys';

const quota = () => Object.assign(new Error('[429] RESOURCE_EXHAUSTED'), { status: 429 });
const ok = (t: string) => () => ({ response: { text: () => t } });
const call = () =>
  new GeminiFailoverClient()
    .getGenerativeModel({ model: 'gemini-flash-lite-latest' })
    .generateContent('hi');

beforeEach(() => {
  resetGeminiKeyState();
  sdk.calls.length = 0;
  sdk.behaviour.clear();
  log.warn.mockClear();
  delete process.env.GOOGLE_GENERATIVE_AI_KEY;
  process.env.GEMINI_API_KEY = 'SECRET-KEY-ONE';
  process.env.GEMINI_API_KEY_2 = 'SECRET-KEY-TWO';
  delete process.env.GEMINI_API_KEY_3;
});
afterEach(() => vi.useRealTimers());

describe('gemini key failover', () => {
  it('orders keys GEMINI_API_KEY, _2, _N and de-duplicates', () => {
    process.env.GEMINI_API_KEY_3 = 'SECRET-KEY-THREE';
    process.env.GEMINI_API_KEY_2 = 'SECRET-KEY-ONE';
    expect(getGeminiKeys()).toEqual(['SECRET-KEY-ONE', 'SECRET-KEY-THREE']);
  });

  it('uses only the first key when it works', async () => {
    sdk.behaviour.set('SECRET-KEY-ONE', ok('a'));
    await call();
    expect(sdk.calls).toEqual(['SECRET-KEY-ONE']);
  });

  it('retries the same request with the next key on 429', async () => {
    sdk.behaviour.set('SECRET-KEY-ONE', () => {
      throw quota();
    });
    sdk.behaviour.set('SECRET-KEY-TWO', ok('b'));
    const r: any = await call();
    expect(r.response.text()).toBe('b');
    expect(sdk.calls).toEqual(['SECRET-KEY-ONE', 'SECRET-KEY-TWO']);
  });

  it('remembers the exhausted key: next call skips it', async () => {
    sdk.behaviour.set('SECRET-KEY-ONE', () => {
      throw quota();
    });
    sdk.behaviour.set('SECRET-KEY-TWO', ok('b'));
    await call();
    sdk.calls.length = 0;
    await call();
    expect(sdk.calls).toEqual(['SECRET-KEY-TWO']);
  });

  it('a daily-quota key stays benched until the next UTC day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    sdk.behaviour.set('SECRET-KEY-ONE', () => {
      throw Object.assign(new Error('RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProject'), {
        status: 429,
      });
    });
    sdk.behaviour.set('SECRET-KEY-TWO', ok('b'));
    await call();
    sdk.calls.length = 0;
    vi.setSystemTime(new Date('2026-10-07T23:59:00Z'));
    await call();
    expect(sdk.calls).toEqual(['SECRET-KEY-TWO']);
    sdk.calls.length = 0;
    vi.setSystemTime(new Date('2026-10-08T00:00:01Z'));
    sdk.behaviour.set('SECRET-KEY-ONE', ok('a'));
    await call();
    expect(sdk.calls).toEqual(['SECRET-KEY-ONE']);
  });

  it('honours a Retry-After style delay over the daily default', () => {
    const now = Date.UTC(2026, 9, 7, 10);
    expect(cooldownFor({ message: 'per day', errorDetails: [{ retryDelay: '34s' }] }, now)).toBe(
      now + 34_000
    );
  });

  it('both keys exhausted -> original 429 surfaces (existing graceful path), then no Google call', async () => {
    for (const k of ['SECRET-KEY-ONE', 'SECRET-KEY-TWO']) {
      sdk.behaviour.set(k, () => {
        throw quota();
      });
    }
    await expect(call()).rejects.toMatchObject({ status: 429 });
    expect(sdk.calls).toHaveLength(2);
    sdk.calls.length = 0;
    await expect(call()).rejects.toMatchObject({ status: 429 });
    expect(sdk.calls).toHaveLength(0);
  });

  it('does not fail over on a non-quota error', async () => {
    sdk.behaviour.set('SECRET-KEY-ONE', () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    await expect(call()).rejects.toMatchObject({ status: 400 });
    expect(sdk.calls).toEqual(['SECRET-KEY-ONE']);
  });

  it('never logs a key value, only the index', async () => {
    sdk.behaviour.set('SECRET-KEY-ONE', () => {
      throw quota();
    });
    sdk.behaviour.set('SECRET-KEY-TWO', ok('b'));
    await call();
    expect(log.warn).toHaveBeenCalled();
    const dump = JSON.stringify(log.warn.mock.calls);
    expect(dump).not.toContain('SECRET-KEY');
    expect(log.warn.mock.calls[0][0]).toMatchObject({ keyIndex: 0 });
  });

  it('a scoped quota error benches the key for that scope only (Ruling B0-51)', async () => {
    const seen: string[] = [];
    const quotaFn = async (k: string) => {
      seen.push(k);
      throw quota();
    };
    await expect(
      withGeminiFailover(quotaFn, undefined, { benchScope: 'grounding' })
    ).rejects.toMatchObject({ status: 429 });
    expect(seen).toEqual(['SECRET-KEY-ONE', 'SECRET-KEY-TWO']);

    // Plain calls still use key one: the grounding bench did not touch it.
    seen.length = 0;
    const plain = await withGeminiFailover(async k => {
      seen.push(k);
      return 'ok';
    });
    expect(plain).toBe('ok');
    expect(seen).toEqual(['SECRET-KEY-ONE']);

    // Grounded calls stay benched: no Google call at all.
    seen.length = 0;
    await expect(
      withGeminiFailover(quotaFn, undefined, { benchScope: 'grounding' })
    ).rejects.toMatchObject({ status: 429 });
    expect(seen).toEqual([]);
  });

  it('an unscoped quota error still benches the key for unscoped calls', async () => {
    await expect(
      withGeminiFailover(async () => {
        throw quota();
      })
    ).rejects.toMatchObject({ status: 429 });
    const seen: string[] = [];
    await expect(
      withGeminiFailover(async k => {
        seen.push(k);
        return 'x';
      })
    ).rejects.toMatchObject({ status: 429 });
    expect(seen).toEqual([]);
  });
});
