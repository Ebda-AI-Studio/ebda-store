/**
 * Prisma over the pg driver adapter (`engineType = "client"`) reports errors in a different SHAPE
 * than the Rust engine did (SP4 Stage 1a). Two things this codebase reads off errors changed:
 *
 *  - a unique violation (P2002) has no `meta.target`; the columns are under
 *    `meta.driverAdapterError.cause.constraint.fields` (stock-adjustment import-key replay,
 *    409 DUPLICATE_VALUE, the merchant-typed-unique check);
 *  - a raw-query failure (P2010) has no `meta.code`; the Postgres SQLSTATE is
 *    `meta.driverAdapterError.cause.originalCode` (deadlock 40P01 -> retry), and an unreachable
 *    server is `cause.kind = 'DatabaseNotReachable'`.
 *
 * The shapes below were captured from a real client against Postgres (Prisma 6.19.3).
 */
import { describe, it, expect, vi } from 'vitest';
import { uniqueViolationTarget } from '@api/lib/prisma-errors';

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { retryOnWriteConflict, isTransientConnectionError } from '@api/lib/db-retry';

const adapterUnique = (fields: string[]) =>
  Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: {
      modelName: 'Store',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "stores_slug_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields },
        },
      },
    },
  });

describe('uniqueViolationTarget', () => {
  it('reads the adapter shape', () => {
    expect(uniqueViolationTarget(adapterUnique(['store_id', 'import_key']))).toEqual([
      'store_id',
      'import_key',
    ]);
  });
  it('still reads the Rust-engine shape (array and string)', () => {
    expect(uniqueViolationTarget({ code: 'P2002', meta: { target: ['sku'] } })).toEqual(['sku']);
    expect(uniqueViolationTarget({ code: 'P2002', meta: { target: 'stores_slug_key' } })).toEqual([
      'stores_slug_key',
    ]);
  });
  it('falls back to a named index / the constraint in the message', () => {
    expect(
      uniqueViolationTarget({
        meta: { driverAdapterError: { cause: { constraint: { index: 'orders_idem_key' } } } },
      })
    ).toEqual(['orders_idem_key']);
    expect(
      uniqueViolationTarget({
        meta: {
          driverAdapterError: {
            cause: { originalMessage: 'duplicate key value violates unique constraint "x_key"' },
          },
        },
      })
    ).toEqual(['x_key']);
  });
  it('is empty for anything else', () => {
    expect(uniqueViolationTarget(null)).toEqual([]);
    expect(uniqueViolationTarget(new Error('x'))).toEqual([]);
  });
});

describe('db-retry reads the adapter error shapes', () => {
  const rawDeadlock = () =>
    Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode: '40P01', originalMessage: 'deadlock detected', kind: 'postgres' },
        },
      },
    });

  it('retries a raw-query deadlock (40P01 under cause.originalCode) when the caller opts in', async () => {
    let n = 0;
    const out = await retryOnWriteConflict(
      async () => {
        if (n++ < 2) throw rawDeadlock();
        return 'ok';
      },
      { extraRetryCodes: ['40P01'], baseDelayMs: 1 }
    );
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry it when the caller did not opt in', async () => {
    await expect(
      retryOnWriteConflict(
        async () => {
          throw rawDeadlock();
        },
        { baseDelayMs: 1 }
      )
    ).rejects.toMatchObject({ code: 'P2010' });
  });

  it('retries a transaction write conflict reported by kind', async () => {
    let n = 0;
    const out = await retryOnWriteConflict(
      async () => {
        if (n++ < 1)
          throw Object.assign(new Error('x'), {
            code: 'P2010',
            meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } },
          });
        return 'ok';
      },
      { baseDelayMs: 1 }
    );
    expect(out).toBe('ok');
  });

  it('an unreachable server on a RAW query counts as P1001 for opt-in callers', async () => {
    let n = 0;
    const out = await retryOnWriteConflict(
      async () => {
        if (n++ < 1)
          throw Object.assign(new Error('x'), {
            code: 'P2010',
            meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', port: 5432 } } },
          });
        return 'ok';
      },
      { extraRetryCodes: ['P1001'], baseDelayMs: 1 }
    );
    expect(out).toBe('ok');
    expect(typeof isTransientConnectionError).toBe('function');
  });
});
