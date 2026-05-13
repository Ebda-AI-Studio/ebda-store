/**
 * Unit tests for the Telegram alerts service (iceberg item #12).
 *
 * The service has three behaviors worth pinning down:
 *   1. graceful no-op when bot creds are missing
 *   2. throttle suppression for repeat (level, title) within 5 min
 *   3. fetch call shape (correct URL, body, timeout signal)
 *
 * Telegram itself + Redis are mocked so the suite is hermetic.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Use vi.hoisted for state shared between mock factories and tests.
const mockState = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  acquireLockMock: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  configValue: { telegramBotToken: '', telegramAlertChatId: '', nodeEnv: 'test' },
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    acquireLock: mockState.acquireLockMock,
    releaseLock: vi.fn(),
  },
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: {
    warn: mockState.loggerWarn,
    error: mockState.loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../apps/api/src/config', () => ({
  config: new Proxy(
    {},
    {
      get(_target, key) {
        return (mockState.configValue as Record<string, unknown>)[key as string];
      },
    }
  ),
}));

// Stub global fetch — Telegram is the only thing the service calls.
beforeEach(() => {
  mockState.fetchMock.mockReset();
  mockState.acquireLockMock.mockReset();
  mockState.loggerWarn.mockReset();
  mockState.loggerError.mockReset();
  mockState.configValue.telegramBotToken = '';
  mockState.configValue.telegramAlertChatId = '';
  mockState.configValue.nodeEnv = 'test';
  vi.stubGlobal('fetch', mockState.fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadService() {
  // Fresh import so the per-module `bootWarningEmitted` latch resets
  // between tests — otherwise the second "no creds" test wouldn't warn.
  vi.resetModules();
  return await import('../../apps/api/src/services/alerts.service');
}

describe('sendAlert — missing creds', () => {
  it('returns skipped when TELEGRAM_BOT_TOKEN is empty', async () => {
    const { sendAlert } = await loadService();
    const result = await sendAlert({ level: 'p0', title: 'X' });
    expect(result).toBe('skipped');
    expect(mockState.fetchMock).not.toHaveBeenCalled();
    expect(mockState.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it('only emits the boot warning once across many sends', async () => {
    const { sendAlert } = await loadService();
    await sendAlert({ level: 'p0', title: 'A' });
    await sendAlert({ level: 'p1', title: 'B' });
    await sendAlert({ level: 'info', title: 'C' });
    expect(mockState.loggerWarn).toHaveBeenCalledTimes(1);
  });
});

describe('sendAlert — configured', () => {
  beforeEach(() => {
    mockState.configValue.telegramBotToken = 'test-token';
    mockState.configValue.telegramAlertChatId = '-1001234567890';
  });

  it('sends to Telegram with the correct URL, chat_id, and message shape', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    const result = await sendAlert({
      level: 'p0',
      title: 'payment.webhook.hmac_fail',
      body: 'tap provider HMAC fail',
      context: { store: 'wady-aljuz', attempts: 3 },
    });

    expect(result).toBe('sent');
    expect(mockState.fetchMock).toHaveBeenCalledTimes(1);

    const [url, opts] = mockState.fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    const body = JSON.parse(opts.body as string);
    expect(body.chat_id).toBe('-1001234567890');
    expect(body.text).toContain('🔴');
    expect(body.text).toContain('[P0]');
    expect(body.text).toContain('payment.webhook.hmac_fail');
    expect(body.text).toContain('tap provider HMAC fail');
    expect(body.text).toContain('"store": "wady-aljuz"');
    expect(body.disable_web_page_preview).toBe(true);
  });

  it('returns throttled when the lock is held', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(false);

    const { sendAlert } = await loadService();
    const result = await sendAlert({ level: 'p1', title: 'flapping' });

    expect(result).toBe('throttled');
    expect(mockState.fetchMock).not.toHaveBeenCalled();
  });

  it('returns failed when Telegram rejects (non-2xx)', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockResolvedValueOnce(
      new Response('{"ok":false,"description":"chat not found"}', { status: 400 })
    );

    const { sendAlert } = await loadService();
    const result = await sendAlert({ level: 'p0', title: 'X' });

    expect(result).toBe('failed');
    expect(mockState.loggerError).toHaveBeenCalledTimes(1);
  });

  it('returns failed and logs when fetch itself throws', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const { sendAlert } = await loadService();
    const result = await sendAlert({ level: 'p0', title: 'Y' });

    expect(result).toBe('failed');
    expect(mockState.loggerError).toHaveBeenCalledTimes(1);
  });

  it('truncates oversized bodies so Telegram does not reject the whole message', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    const bigBody = 'X'.repeat(8000);
    await sendAlert({ level: 'p0', title: 'big', body: bigBody });

    const body = JSON.parse(mockState.fetchMock.mock.calls[0][1].body as string);
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).toContain('…');
  });

  it('uses different throttle keys for different (level, title) pairs', async () => {
    // First call locks key A, second call requests key B — both should
    // succeed because they hash to different keys.
    mockState.acquireLockMock.mockResolvedValue(true);
    mockState.fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    await sendAlert({ level: 'p0', title: 'A' });
    await sendAlert({ level: 'p0', title: 'B' });

    const calls = mockState.acquireLockMock.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).not.toBe(calls[1][0]);
  });
});
