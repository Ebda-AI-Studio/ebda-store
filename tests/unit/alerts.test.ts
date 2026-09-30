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
    expect(body.text).toContain('[P0 PLATFORM]'); // default scope when omitted
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

  // Issue 2384: a Redis that is connected but rejecting writes (OOM,
  // MISCONF, read-only) makes the throttle SET NX throw. That is the state
  // the dead-letter `unreadable_lost` P1 fires in, so the throttle must
  // fail open — the alert still goes out, and sendAlert never rejects.
  it('fails open and still POSTs when the throttle SET rejects', async () => {
    mockState.acquireLockMock.mockRejectedValueOnce(
      new Error('OOM command not allowed when used memory > maxmemory')
    );
    mockState.fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    const result = await sendAlert({ level: 'p1', title: 'Unreadable queued SMS lost' });

    expect(result).toBe('sent');
    expect(mockState.fetchMock).toHaveBeenCalledTimes(1);
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

  it('renders platform-scoped header tag and includes source line', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    await sendAlert({
      level: 'p0',
      scope: 'platform',
      source: 'process.uncaughtException',
      title: 'uncaughtException',
    });

    const body = JSON.parse(mockState.fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('[P0 PLATFORM]');
    expect(body.text).toContain('source=process.uncaughtException');
    expect(body.text).not.toContain('store=');
  });

  it('renders store-scoped header tag and store-identity line', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    await sendAlert({
      level: 'p1',
      scope: 'store',
      store: { id: 'dfc1c208-1c30-4eba-9821-6f3be15e3506', name: 'Wady Aljuz', slug: 'wady-aljuz' },
      source: 'payment.webhook.hmac_fail',
      title: 'hmac fail',
    });

    const body = JSON.parse(mockState.fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('[P1 STORE]');
    expect(body.text).toContain('store=Wady Aljuz');
    expect(body.text).toContain('wady-aljuz');
    expect(body.text).toContain('dfc1c208'); // truncated id suffix
    expect(body.text).toContain('source=payment.webhook.hmac_fail');
  });

  it('uses isolated throttle keys per store so a flapping store A does not suppress store B', async () => {
    mockState.acquireLockMock.mockResolvedValue(true);
    mockState.fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    await sendAlert({
      level: 'p0',
      scope: 'store',
      store: { id: 'store-a-id', name: 'A' },
      title: 'hmac fail',
    });
    await sendAlert({
      level: 'p0',
      scope: 'store',
      store: { id: 'store-b-id', name: 'B' },
      title: 'hmac fail', // same title, different store → must be separate key
    });

    const keys = mockState.acquireLockMock.mock.calls.map(c => c[0]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('logs a warn but still delivers when scope=store with no store context', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const { sendAlert } = await loadService();
    const result = await sendAlert({
      level: 'p0',
      scope: 'store',
      // store: undefined — caller-side mistake
      title: 'broken-fan-out',
    });

    expect(result).toBe('sent'); // graceful degrade
    expect(mockState.loggerWarn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockState.fetchMock.mock.calls[0][1].body as string);
    // Header still says STORE (caller's intent) but no store= line because we have no data
    expect(body.text).toContain('[P0 STORE]');
    expect(body.text).not.toContain('store=');
  });
});

// Issue 2387: detached sends (`void sendAlert(...)`, the orphaned-invoice
// page) were dropped on SIGTERM — gracefulShutdown disconnected Redis and
// exited with the Telegram POST still in flight. It now awaits them.
describe('awaitInFlightAlerts — graceful-shutdown drain', () => {
  beforeEach(() => {
    mockState.configValue.telegramBotToken = 'test-token';
    mockState.configValue.telegramAlertChatId = '-1001234567890';
  });

  it('waits for a detached send that is still in flight', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    let release!: (r: Response) => void;
    mockState.fetchMock.mockReturnValueOnce(new Promise<Response>(r => (release = r)));

    const { sendAlert, awaitInFlightAlerts } = await loadService();
    let delivered = false;
    void sendAlert({ level: 'p1', title: 'orphan' }).then(() => (delivered = true));

    const drained = awaitInFlightAlerts(5000);
    await new Promise(r => setTimeout(r, 20));
    expect(delivered).toBe(false);
    release(new Response('{"ok":true}', { status: 200 }));
    await drained;
    expect(delivered).toBe(true);
  });

  it('is bounded: a send that never settles does not hold shutdown past the timeout', async () => {
    mockState.acquireLockMock.mockResolvedValueOnce(true);
    mockState.fetchMock.mockReturnValueOnce(new Promise<Response>(() => undefined));
    const { sendAlert, awaitInFlightAlerts } = await loadService();
    void sendAlert({ level: 'p1', title: 'hang' });
    const t0 = Date.now();
    await awaitInFlightAlerts(30);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('returns immediately when nothing is in flight', async () => {
    const { awaitInFlightAlerts } = await loadService();
    await expect(awaitInFlightAlerts(10_000)).resolves.toBeUndefined();
  });
});

describe('gracefulShutdown wiring (issue 2387)', () => {
  it('drains in-flight alerts before Redis is disconnected', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../apps/api/src/index.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function gracefulShutdown'));
    const drain = body.indexOf('await awaitInFlightAlerts(');
    const disconnect = body.indexOf('await redis.disconnect()');
    expect(drain).toBeGreaterThan(-1);
    expect(disconnect).toBeGreaterThan(drain);
  });
});
