/**
 * Prisma known-error mapping in the global error handler.
 *
 * Regression test for the 2026-09-02 production defect: setting an SKU that
 * another product in the store already used returned
 *
 *     500  { code: 'DATABASE_ERROR', message: 'A database error occurred' }
 *
 * because every PrismaClientKnownRequestError collapsed into one 500. The
 * merchant had no way to know what to change, and the cause (P2002 on
 * store_id+sku) was only visible in the Railway logs.
 *
 * A constraint violation is the caller's fault, so it must be a 4xx that names
 * the field in business terms — while still never echoing Prisma's code,
 * message or raw meta.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@ebda/database';
import { errorHandler } from '@api/middleware/error-handler';

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: { error?: { code?: string; message?: string; requestId?: string } };
  };
}

const req = { headers: {}, method: 'PUT', path: '/x' } as unknown as Request;
const next = vi.fn() as unknown as NextFunction;

function prismaError(code: string, target?: string[]) {
  return new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: '6.19.3',
    meta: target ? { modelName: 'Product', target } : undefined,
  });
}

describe('Prisma error mapping', () => {
  it('maps a duplicate SKU to 409 and NAMES the field (the production case)', () => {
    const res = makeRes();
    errorHandler(prismaError('P2002', ['store_id', 'sku']), req, res, next);

    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe('DUPLICATE_VALUE');
    expect(res.body.error?.message).toContain('SKU');
  });

  it('does not mention the tenant-scoping column in the merchant-facing message', () => {
    const res = makeRes();
    errorHandler(prismaError('P2002', ['store_id', 'sku']), req, res, next);
    expect(res.body.error?.message).not.toMatch(/store_id|storeId/);
  });

  it('NEVER names email — that would reopen the closed registration oracle', () => {
    // auth.routes.ts documents control T1-4: register returns an identical body
    // whether or not the address exists. Its findFirst pre-check is TOCTOU, so a
    // concurrent duplicate reaches the unique index; if this handler said "that
    // email address is already used", the 409 would be exactly the enumeration
    // oracle T1-4 removed — on an unauthenticated route.
    const res = makeRes();
    errorHandler(prismaError('P2002', ['store_id', 'email']), req, res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.message).not.toMatch(/email/i);
    expect(res.body.error?.message).toContain('already in use');
  });

  it('maps a duplicate slug to 409 naming the URL slug', () => {
    const res = makeRes();
    errorHandler(prismaError('P2002', ['store_id', 'slug']), req, res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.message).toContain('URL slug');
  });

  it('degrades to a generic 409 for a column not on the allowlist — never leaks it', () => {
    const res = makeRes();
    errorHandler(prismaError('P2002', ['store_id', 'some_internal_column']), req, res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.message).not.toContain('some_internal_column');
    expect(res.body.error?.message).toContain('already in use');
  });

  it('maps a missing record to 404 rather than 500', () => {
    const res = makeRes();
    errorHandler(prismaError('P2025'), req, res, next);
    expect(res.statusCode).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('maps a foreign-key violation to 400', () => {
    const res = makeRes();
    errorHandler(prismaError('P2003'), req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_REFERENCE');
  });

  it('still 500s an unrecognised Prisma error, leaking nothing', () => {
    const res = makeRes();
    errorHandler(prismaError('P2034'), req, res, next);
    expect(res.statusCode).toBe(500);
    expect(res.body.error?.code).toBe('DATABASE_ERROR');
    expect(res.body.error?.message).toBe('A database error occurred');
  });

  it('never echoes the Prisma code or raw message to the client', () => {
    for (const code of ['P2002', 'P2025', 'P2003', 'P2034']) {
      const res = makeRes();
      errorHandler(prismaError(code, ['store_id', 'sku']), req, res, next);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain('boom');
    }
  });
});
