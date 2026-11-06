/**
 * NEON-ZERO N-17 (Ruling NZ-D23): the Worker has no Postgres. A Prisma call that still reaches the database layer must
 * fail LOUD and at once (POSTGRES_REMOVED) instead of connecting; a `pg` store answers 410 on a Worker only.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createPostgresRemovedClient,
  PostgresRemovedError,
  POSTGRES_REMOVED,
  runWithRequestDb,
  prisma,
} from '../../packages/database/src';

describe('Postgres-removed client', () => {
  it('every model, raw and transaction call throws POSTGRES_REMOVED, and onFirst fires once per client', async () => {
    const onFirst = vi.fn();
    const client = createPostgresRemovedClient(onFirst);
    expect(() => (client as any).product.findMany()).toThrow(PostgresRemovedError);
    expect(() => (client as any).$queryRaw`SELECT 1`).toThrow(POSTGRES_REMOVED);
    expect(() => (client as any).$transaction(async () => 1)).toThrow(/POSTGRES_REMOVED/);
    expect(onFirst).toHaveBeenCalledTimes(1);
  });

  it('disconnect is a no-op and awaiting the client is not a database call', async () => {
    const onFirst = vi.fn();
    const client = createPostgresRemovedClient(onFirst);
    await expect((client as any).$disconnect()).resolves.toBeUndefined();
    expect(await Promise.resolve(client)).toBe(client);
    expect(onFirst).not.toHaveBeenCalled();
  });

  it('a failing alert hook never masks the real error', () => {
    const client = createPostgresRemovedClient(() => {
      throw new Error('alert down');
    });
    expect(() => (client as any).store.findUnique()).toThrow(POSTGRES_REMOVED);
  });

  it('the exported prisma inside runWithRequestDb(removed client) throws instead of connecting', async () => {
    const onFirst = vi.fn();
    await expect(
      runWithRequestDb(
        () => createPostgresRemovedClient(onFirst),
        async () => (prisma as any).order.findMany()
      )
    ).rejects.toThrow(POSTGRES_REMOVED);
    expect(onFirst).toHaveBeenCalledTimes(1);
  });
});

describe('POSTGRES_REMOVED reporter is actionable (2026-11-06 P1)', () => {
  it('names the caller and carries at most 8 stack frames', async () => {
    const { postgresRemovedWhere } = await import('../../packages/database/src');
    const err = new PostgresRemovedError('$transaction');
    const named = postgresRemovedWhere(err, 'cron 0 3 * * *');
    expect(named.caller).toBe('cron 0 3 * * *');
    expect(named.frames.length).toBeGreaterThan(0);
    expect(named.frames.length).toBeLessThanOrEqual(8);
    expect(named.frames.every(f => f.startsWith('at '))).toBe(true);
    expect(postgresRemovedWhere(err, undefined).caller).toMatch(/unlabelled/);
  });
});
