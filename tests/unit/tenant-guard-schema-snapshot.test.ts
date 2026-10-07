/**
 * The tenant guard must not touch `Prisma.dmmf` at request time (R-EBDA-003).
 *
 * On Workers `Prisma.dmmf` throws ("not available when running in edge runtimes"). The first
 * deploy of the guard read it, so every API request 500'd (error 1101) and had to be rolled
 * back. The guard now reads a committed snapshot; this file proves (1) the snapshot still
 * equals the generated client's DMMF (a schema change without
 * `npm run gen:tenant-guard-schema -w packages/database` turns this red), and (2) the guard
 * works with `Prisma.dmmf` unavailable, which is what Workers gives it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@prisma/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  return { ...actual, Prisma: { ...actual.Prisma, dmmf: undefined } };
});

import { Prisma as RealPrisma } from '@prisma/client';
import { TENANT_GUARD_SCHEMA } from '../../packages/database/src/tenant-guard-schema.generated';
import {
  assertTenantScoped,
  assertRawScoped,
  storeIdModels,
  TenantScopeViolation,
} from '../../packages/database/src/tenant-guard';

describe('tenant guard schema snapshot', () => {
  it('equals the generated client DMMF', async () => {
    const actual = await vi.importActual<typeof import('@prisma/client')>('@prisma/client');
    const models = actual.Prisma.dmmf.datamodel.models;
    const derived = models.map(m => ({
      name: m.name,
      table: m.dbName ?? m.name,
      storeId: m.fields.some(f => f.name === 'storeId' && f.kind === 'scalar'),
      relations: Object.fromEntries(
        m.fields.filter(f => f.kind === 'object').map(f => [f.name, f.type])
      ),
    }));
    expect(TENANT_GUARD_SCHEMA).toEqual(derived);
  });

  it('works with Prisma.dmmf unavailable (Workers)', () => {
    expect((RealPrisma as { dmmf?: unknown }).dmmf).toBeUndefined();
    expect(storeIdModels().length).toBeGreaterThan(20);
    expect(storeIdModels()).toContain('Product');
    expect(() =>
      assertRawScoped('$queryRawUnsafe', ['SELECT * FROM products'], {} as never)
    ).toThrow(TenantScopeViolation);
    expect(() =>
      assertTenantScoped('Product', 'findMany', { where: { storeId: 'a' } }, {
        storeId: 'a',
      } as never)
    ).not.toThrow();
  });
});
