/**
 * The code-level tenant guard covers EVERY tenant model, including ones added later
 * (R-EBDA-003).
 *
 * The guard reads its tenant-model list from the generated client's DMMF at boot, so a new
 * model with a `storeId` column is guarded without touching the guard. This file proves that
 * from an INDEPENDENT source, `schema.prisma` itself: every model it declares with a `storeId`
 * field must be refused contextless and accepted when scoped to the ambient store. The child
 * list (tenant rows with no storeId, scoped through a parent) is a hand list in the guard, so
 * it is re-derived here from the schema's `@relation(fields: ...)` graph and must match: a new
 * child model turns this red until it is added.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertTenantScoped,
  storeIdModels,
  TENANT_CHILD_MODELS,
  IDENTITY_MODELS,
  TenantScopeViolation,
} from '../../packages/database/src/tenant-guard';

const SCHEMA = fs.readFileSync(
  path.resolve(__dirname, '../../packages/database/prisma/schema.prisma'),
  'utf8'
);

interface ParsedModel {
  name: string;
  scalars: Set<string>;
  /** relation fields that hold the FK on this side: field type */
  owningRelations: string[];
}

function parseModels(): ParsedModel[] {
  const out: ParsedModel[] = [];
  for (const m of SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const scalars = new Set<string>();
    const owningRelations: string[] = [];
    for (const line of m[2].split('\n')) {
      const f = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!f || f[1].startsWith('@')) continue;
      scalars.add(f[1]);
      if (/@relation\([^)]*fields:\s*\[/.test(f[5]) && !f[3]) owningRelations.push(f[2]);
    }
    out.push({ name: m[1], scalars, owningRelations });
  }
  return out;
}

const models = parseModels();
const A = '11111111-1111-4111-8111-111111111111';

describe('tenant guard model coverage (schema.prisma vs the guard)', () => {
  it('the parser sees the schema (positive control)', () => {
    expect(models.length).toBeGreaterThan(100);
    expect(models.find(m => m.name === 'Product')?.scalars.has('storeId')).toBe(true);
  });

  const declared = models
    .filter(m => m.scalars.has('storeId'))
    .map(m => m.name)
    .sort();

  it("the guard treats exactly the schema's storeId models as tenant models", () => {
    expect([...storeIdModels()].sort()).toEqual(declared);
  });

  for (const model of declared) {
    it(`${model}: contextless findMany is refused; scoped to the ambient store it passes`, () => {
      expect(() => assertTenantScoped(model, 'findMany', {}, {})).toThrow(TenantScopeViolation);
      expect(() =>
        assertTenantScoped(model, 'findMany', { where: { storeId: A } }, { storeId: A })
      ).not.toThrow();
      expect(() =>
        assertTenantScoped(model, 'create', { data: { storeId: 'another' } }, { storeId: A })
      ).toThrow(TenantScopeViolation);
    });
  }

  it("the child list equals the schema's tenant children (FK to a tenant row, no storeId)", () => {
    const tenant = new Set(declared.filter(m => !(m in IDENTITY_MODELS)));
    const children = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of models) {
        if (m.scalars.has('storeId') || children.has(m.name) || m.name === 'Store') continue;
        if (m.owningRelations.some(t => tenant.has(t) || children.has(t))) {
          children.add(m.name);
          grew = true;
        }
      }
    }
    expect([...children].sort()).toEqual([...TENANT_CHILD_MODELS].sort());
  });

  for (const model of TENANT_CHILD_MODELS) {
    it(`${model} (child): refused with no ambient store`, () => {
      expect(() => assertTenantScoped(model, 'findMany', {}, {})).toThrow(TenantScopeViolation);
    });
  }
});
