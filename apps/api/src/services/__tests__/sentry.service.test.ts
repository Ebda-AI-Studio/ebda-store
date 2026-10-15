import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @sentry/node so we can assert capture without a real DSN / network.
const captureException = vi.fn();
vi.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  init: vi.fn(),
  setUser: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

import { SentryService } from '../sentry.service';

/**
 * F1 regression (2026-06-10 audit): the error-handler middleware gated on
 * `err.status`, but AppError carries `statusCode`. Every 4xx (validation/auth/
 * not-found) therefore satisfied `!err.status` and got captured — 4957x/242x/
 * 115x Sentry noise. These tests pin the corrected gate: capture ONLY 5xx or
 * unknown-code (genuine uncaught) errors, never 4xx.
 */
describe('SentryService.errorHandler gate', () => {
  // Force the initialized branch without booting real Sentry.
  beforeEach(() => {
    captureException.mockClear();
    (SentryService as unknown as { isInitialized: boolean }).isInitialized = true;
  });

  const run = (err: Error & { status?: number; statusCode?: number }) => {
    const next = vi.fn();
    const req = { url: '/x', method: 'GET', headers: {} } as never;
    SentryService.errorHandler()(err, req, {} as never, next);
    expect(next).toHaveBeenCalledWith(err); // always forwards
  };

  it('does NOT capture an AppError-shaped 400 (statusCode)', () => {
    run(Object.assign(new Error('bad input'), { statusCode: 400 }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does NOT capture a 404 (statusCode)', () => {
    run(Object.assign(new Error('not found'), { statusCode: 404 }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('captures a 500 (statusCode)', () => {
    run(Object.assign(new Error('boom'), { statusCode: 500 }));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('captures an uncaught error with no code (genuine crash)', () => {
    run(new Error('undefined behaviour'));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('still honours legacy `status` (non-AppError) for 4xx', () => {
    run(Object.assign(new Error('legacy 401'), { status: 401 }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('never sends a phone typed into ?search= in the captured URL (search log review)', () => {
    const next = vi.fn();
    const req = {
      url: '/api/v1/public/products?search=01012345678&page=1',
      method: 'GET',
      headers: {},
    } as never;
    SentryService.errorHandler()(new Error('crash'), req, {} as never, next);
    expect(captureException).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(captureException.mock.calls[0]);
    expect(sent).not.toContain('01012345678');
    expect(sent).toContain('search=[Filtered]&page=1');
  });
});
