/**
 * On Workers `SentryService.init()` is a stub and may run (at module scope) before the secrets are
 * readable, leaving isInitialized false. The 5xx handler and the explicit captures must still capture
 * there, because the real client is the request's (Sentry.withSentry). In Node they stay gated on init().
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ workers: true }));
const captureException = vi.hoisted(() => vi.fn(() => 'evt-1'));
vi.mock('@sentry/node', () => ({
  captureException,
  init: vi.fn(),
  setUser: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@api/lib/runtime', () => ({
  get isWorkers() {
    return h.workers;
  },
}));

const { SentryService } = await import('@api/services/sentry.service');

const run500 = () => {
  const next = vi.fn();
  SentryService.errorHandler()(
    Object.assign(new Error('boom'), { statusCode: 500 }),
    { url: '/x', method: 'GET', headers: {} } as never,
    {} as never,
    next
  );
  expect(next).toHaveBeenCalled();
};

beforeEach(() => {
  captureException.mockClear();
  (SentryService as unknown as { isInitialized: boolean }).isInitialized = false;
});

describe('SentryService on Workers without init()', () => {
  it('captures a 5xx from the Express error handler', () => {
    h.workers = true;
    run500();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
  it('captureException returns the event id instead of logging and dropping', () => {
    h.workers = true;
    expect(SentryService.captureException(new Error('x'))).toBe('evt-1');
  });
  it('control: in Node, before init(), nothing is captured', () => {
    h.workers = false;
    run500();
    expect(SentryService.captureException(new Error('x'))).toBe('');
    expect(captureException).not.toHaveBeenCalled();
  });
});
