import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -------------------------------------------------------------
// The registry reads AnswerEngineProviderConfig rows via Prisma and
// decrypts keys via the real encryption service (so the test can encrypt
// with the same service and assert the registry decrypted correctly).
// The concrete provider classes are mocked so this test stays scoped to
// registry wiring (which engines get built, with which key) rather than
// re-testing each adapter's own HTTP behavior (covered by their own specs).
//
// The encryption service reads config.encryptionKey once at first use, so
// ENCRYPTION_KEY must be set before anything imports it — vi.hoisted runs
// before the static imports below are evaluated, unlike a plain top-level
// statement (which would run too late relative to hoisted imports).
vi.hoisted(() => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a-32-character-test-encryption-key!';
});

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock('@ebda/database', () => ({
  prisma: { answerEngineProviderConfig: { findMany: mockFindMany } },
}));

const { MockGemini, MockPerplexity, MockOpenAi } = vi.hoisted(() => {
  class MockGemini {
    engine = 'gemini';
    query = vi.fn();
  }
  class MockPerplexity {
    engine = 'perplexity';
    constructor(public readonly apiKey: string) {}
    query = vi.fn();
  }
  class MockOpenAi {
    engine = 'openai';
    constructor(public readonly apiKey: string) {}
    query = vi.fn();
  }
  return { MockGemini, MockPerplexity, MockOpenAi };
});

vi.mock('../gemini.provider', () => ({ GeminiAnswerEngineProvider: MockGemini }));
vi.mock('../perplexity.provider', () => ({ PerplexityAnswerEngineProvider: MockPerplexity }));
vi.mock('../openai.provider', () => ({ OpenAiAnswerEngineProvider: MockOpenAi }));

import { encryption } from '../../encryption.service';
import { getEnabledProviders } from '../registry';

type ConfigRow = {
  id: string;
  engine: string;
  apiKey: string | null;
  enabled: boolean;
  updatedAt: Date;
};

function row(overrides: Partial<ConfigRow>): ConfigRow {
  return {
    id: 'cfg-1',
    engine: 'perplexity',
    apiKey: null,
    enabled: false,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('getEnabledProviders', () => {
  beforeEach(() => {
    mockFindMany.mockReset();
  });

  it('returns only gemini when there are no config rows', async () => {
    mockFindMany.mockResolvedValue([]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini']);
  });

  it('includes an enabled + keyed perplexity provider, constructed with the decrypted key', async () => {
    const rawKey = 'pplx-super-secret-key';
    mockFindMany.mockResolvedValue([
      row({ engine: 'perplexity', enabled: true, apiKey: encryption.encrypt(rawKey) }),
    ]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini', 'perplexity']);
    const perplexity = providers[1] as InstanceType<typeof MockPerplexity>;
    expect(perplexity.apiKey).toBe(rawKey);
  });

  it('includes an enabled + keyed openai provider alongside gemini', async () => {
    const rawKey = 'sk-super-secret-key';
    mockFindMany.mockResolvedValue([
      row({ engine: 'openai', enabled: true, apiKey: encryption.encrypt(rawKey) }),
    ]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini', 'openai']);
    const openai = providers[1] as InstanceType<typeof MockOpenAi>;
    expect(openai.apiKey).toBe(rawKey);
  });

  it('excludes a disabled row even when it has a key', async () => {
    mockFindMany.mockResolvedValue([
      row({ engine: 'perplexity', enabled: false, apiKey: encryption.encrypt('some-key') }),
    ]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini']);
  });

  it('excludes an enabled row with no apiKey set', async () => {
    mockFindMany.mockResolvedValue([row({ engine: 'openai', enabled: true, apiKey: null })]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini']);
  });

  it('skips a row for an unknown engine name rather than throwing', async () => {
    mockFindMany.mockResolvedValue([
      row({ engine: 'not-a-real-engine', enabled: true, apiKey: encryption.encrypt('key') }),
    ]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini']);
  });

  it('skips a row whose apiKey fails to decrypt (corrupted ciphertext) rather than throwing, keeping other rows', async () => {
    const rawKey = 'sk-good-key';
    mockFindMany.mockResolvedValue([
      row({ engine: 'perplexity', enabled: true, apiKey: 'not-valid-ciphertext' }),
      row({ engine: 'openai', enabled: true, apiKey: encryption.encrypt(rawKey) }),
    ]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini', 'openai']);
  });

  it('includes both perplexity and openai when both rows are enabled + keyed', async () => {
    mockFindMany.mockResolvedValue([
      row({ engine: 'perplexity', enabled: true, apiKey: encryption.encrypt('pplx-key') }),
      row({ engine: 'openai', enabled: true, apiKey: encryption.encrypt('sk-key') }),
    ]);

    const providers = await getEnabledProviders();

    expect(providers.map(p => p.engine)).toEqual(['gemini', 'perplexity', 'openai']);
  });
});
