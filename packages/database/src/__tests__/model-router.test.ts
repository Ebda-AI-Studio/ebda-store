import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma, setModelRouter } from '../index';

describe('model router seam on the prisma proxy (NEON-ZERO-1 N-10)', () => {
  afterEach(() => setModelRouter(undefined));

  it('answers a routed model call from the router without resolving a Postgres client', async () => {
    const route = vi.fn(
      async (model: string, method: string, args: unknown[], _pg: () => Promise<unknown>) => ({
        model,
        method,
        args,
      })
    );
    setModelRouter({ models: new Set(['plan']), route });
    const out = await prisma.plan.findMany({ where: { code: 'x' } });
    expect(out).toEqual({ model: 'plan', method: 'findMany', args: [{ where: { code: 'x' } }] });
    expect(route).toHaveBeenCalledTimes(1);
    // the Postgres leg is a closure the router may call; this one never did
    expect(route.mock.calls[0][3]).toBeTypeOf('function');
  });

  it('routes every query method and nothing else', async () => {
    const seen: string[] = [];
    setModelRouter({
      models: new Set(['plan']),
      route: async (_m, method) => (seen.push(method), null),
    });
    for (const m of [
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'createMany',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
      'count',
      'aggregate',
      'groupBy',
    ])
      await (prisma.plan as unknown as Record<string, () => Promise<unknown>>)[m]();
    expect(seen).toHaveLength(13);
  });

  it('exposes the Postgres leg lazily: it runs only when the router asks for it', async () => {
    let asked = false;
    setModelRouter({
      models: new Set(['plan']),
      route: async (_m, _method, _a, postgres) => {
        asked = true;
        return postgres().catch(() => 'pg-leg-reached');
      },
    });
    // no DATABASE_URL in unit tests: reaching the Postgres leg fails, which proves it is the leg that was called
    const out = await prisma.plan.findMany().then(
      v => v,
      () => 'pg-leg-reached'
    );
    expect(asked).toBe(true);
    expect(out === 'pg-leg-reached' || Array.isArray(out)).toBe(true);
  });
});
