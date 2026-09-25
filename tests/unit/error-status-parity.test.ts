/**
 * Client errors must not reach Sentry as crashes.
 *
 * `SentryService.errorHandler()` runs before the API's `errorHandler` and
 * decided capture from `err.statusCode ?? err.status`. A ZodError carries
 * neither, so every failed `schema.parse(req.body)` was reported even though
 * the client got a 400: FORCE-API-2C (158 events, `public.routes`
 * `schema.parse(req.query)`), FORCE-API-1B / 25 (`auth.routes` login/register),
 * FORCE-API-27 (`admin.routes`). Same hole for a Prisma P2002 answered as 409
 * (FORCE-API-2A, duplicate SKU on product update) and P2025/P2003.
 *
 * Two layers of proof:
 *   1. PARITY — for every error class, the status the real `errorHandler`
 *      writes equals `clientErrorStatus(err)` (or is a 5xx when it returns
 *      undefined). If someone adds a new 4xx mapping to `errorHandler` without
 *      teaching the classifier, this goes red.
 *   2. The real Sentry gate: 4xx-mapped errors are not captured, 5xx ones are.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z, ZodError } from 'zod';

const captureException = vi.fn();
vi.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  init: vi.fn(),
  setUser: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@sentry/profiling-node', () => ({ nodeProfilingIntegration: vi.fn() }));

import { Prisma } from '@force/database';
import {
  AppError,
  clientErrorStatus,
  errorHandler,
} from '../../apps/api/src/middleware/error-handler';
import { SentryService } from '../../apps/api/src/services/sentry.service';

function zodError(): ZodError {
  // The exact shape of FORCE-API-2C: a query missing every required key.
  const r = z
    .object({ orderId: z.string(), productId: z.string(), token: z.string() })
    .safeParse({});
  if (r.success) throw new Error('unreachable');
  return r.error;
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma ${code}`, {
    code,
    clientVersion: 'test',
    meta: code === 'P2002' ? { target: ['store_id', 'sku'] } : undefined,
  });
}

function bodyParserSyntaxError(): SyntaxError {
  return Object.assign(new SyntaxError('Unexpected token'), { body: '{' });
}

const CASES: Array<[string, () => Error]> = [
  ['ZodError', zodError],
  ['body-parser SyntaxError', bodyParserSyntaxError],
  ['AppError 400', () => new AppError(400, 'BAD', 'bad')],
  ['AppError 404', () => new AppError(404, 'NOT_FOUND', 'nf')],
  ['AppError 503', () => new AppError(503, 'DOWN', 'down')],
  ['Prisma P2002', () => prismaError('P2002')],
  ['Prisma P2025', () => prismaError('P2025')],
  ['Prisma P2003', () => prismaError('P2003')],
  ['Prisma P1001 (unreachable DB)', () => prismaError('P1001')],
  ['plain Error', () => new Error('boom')],
];

function statusWrittenBy(err: Error): number {
  let status = 0;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  errorHandler(err, { headers: {} } as never, res as never, vi.fn());
  return status;
}

describe('clientErrorStatus ↔ errorHandler parity', () => {
  it.each(CASES)('%s', (_name, make) => {
    const err = make();
    const classified = clientErrorStatus(err);
    const written = statusWrittenBy(err);
    if (classified === undefined) expect(written).toBeGreaterThanOrEqual(500);
    else expect(written).toBe(classified);
  });
});

describe('SentryService.errorHandler — client errors are not captured', () => {
  beforeEach(() => {
    captureException.mockClear();
    (SentryService as unknown as { isInitialized: boolean }).isInitialized = true;
  });

  const gate = (err: Error) => {
    const next = vi.fn();
    SentryService.errorHandler()(
      err,
      { url: '/x', method: 'GET', headers: {} } as never,
      {} as never,
      next
    );
    expect(next).toHaveBeenCalledWith(err);
  };

  it.each(CASES)('%s', (_name, make) => {
    const err = make();
    gate(err);
    const answeredWith = statusWrittenBy(err);
    expect(captureException).toHaveBeenCalledTimes(answeredWith >= 500 ? 1 : 0);
  });

  it('the FORCE-API-2C ZodError specifically is not captured', () => {
    gate(zodError());
    expect(captureException).not.toHaveBeenCalled();
  });
});
