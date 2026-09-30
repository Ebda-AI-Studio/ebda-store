/**
 * Regression for #1606: errorHandler had no `res.headersSent` guard, so
 * every branch called res.status().json() (which calls res.end()) even
 * when a response had ALREADY gone out. request-transaction.ts's buffered
 * lane forwards every res.end() call straight to Express's real res.end
 * once it has flushed a captured response, so a stray error reaching
 * errorHandler after that point would call the real res.end() a SECOND
 * time — the shape Express's own docs warn a custom error handler must
 * guard against.
 */
import { describe, it, expect, vi } from 'vitest';
import { errorHandler, AppError } from '@api/middleware/error-handler';

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function mockReq() {
  return { headers: {}, originalUrl: '/api/v1/stores/s1/orders' } as any;
}

function mockRes(headersSent: boolean) {
  const res: any = { headersSent };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler — res.headersSent guard (#1606)', () => {
  it('delegates to next(err) instead of writing a response when headers were already sent', () => {
    const res = mockRes(true);
    const next = vi.fn();
    const err = new AppError(400, 'SOME_ERROR', 'boom');

    errorHandler(err, mockReq(), res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('still writes a normal response when headers have NOT been sent', () => {
    const res = mockRes(false);
    const next = vi.fn();
    const err = new AppError(400, 'SOME_ERROR', 'boom');

    errorHandler(err, mockReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
