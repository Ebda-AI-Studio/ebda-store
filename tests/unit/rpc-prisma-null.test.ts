import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { decodeRpc, encodeRpc, revivePrismaNulls, wirePrismaNulls } from '@ebda-src/repo';

// 2026-11-10 P1 (Ruling PRISMA-NULL-RPC-1): a product edit on a DO store sent `personalisation: Prisma.DbNull` to the
// StoreDO; structured clone refused it (DataCloneError "QPe") and every product save answered 500.
describe('Prisma null sentinels cross the StoreDO RPC', () => {
  const args = {
    where: { id: 'p1', storeId: 's1', meta: { equals: Prisma.AnyNull } },
    data: { personalisation: Prisma.DbNull, facts: Prisma.JsonNull, name: 'x', at: new Date(5) },
  };

  it('the structured-clone transport carries a tagged copy and the DO revives the same sentinels', () => {
    const wire = wirePrismaNulls([{ model: 'product', op: 'update', args }]);
    expect(() => structuredClone(wire)).not.toThrow();
    const [q] = revivePrismaNulls(structuredClone(wire));
    expect(q.args.data.personalisation).toBe(Prisma.DbNull);
    expect(q.args.data.facts).toBe(Prisma.JsonNull);
    expect(q.args.where.meta.equals).toBe(Prisma.AnyNull);
    expect(q.args.data.at).toEqual(new Date(5));
    expect(q.args.data.name).toBe('x');
  });

  it('an untagged sentinel does not survive a clone (workerd RPC throws DataCloneError; Node copies it and loses it)', () => {
    let cloned: unknown;
    try {
      cloned = structuredClone({ personalisation: Prisma.DbNull }).personalisation;
    } catch {
      cloned = 'threw';
    }
    expect(cloned).not.toBe(Prisma.DbNull);
  });

  it('a value with no sentinel is passed through untouched', () => {
    const plain = { a: [1, { b: null }], d: new Date(1) };
    expect(wirePrismaNulls(plain)).toBe(plain);
    expect(revivePrismaNulls(plain)).toBe(plain);
  });

  it('the JSON codec (stock / money / settings RPCs) round-trips the sentinels instead of writing {}', () => {
    const back = decodeRpc<typeof args>(encodeRpc(args));
    expect(back.data.personalisation).toBe(Prisma.DbNull);
    expect(back.data.facts).toBe(Prisma.JsonNull);
    expect(back.where.meta.equals).toBe(Prisma.AnyNull);
  });
});
