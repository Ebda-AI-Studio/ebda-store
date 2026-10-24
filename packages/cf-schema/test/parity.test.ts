// Task 1.6: Prisma <-> SQLite <-> Drizzle parity. Three independent readers must agree:
//   * the runtime DMMF (names, kinds, nullability, db names),
//   * the schema.prisma parser (defaults, which the DMMF omits),
//   * the SQLite catalog after the migrations are applied (PRAGMA table_info),
//   * the committed Drizzle definitions (getTableConfig).
// A Prisma column added without a regenerate, or renamed here, fails.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { parseSchema } from '../scripts/prisma-parse.mjs';
import { extraColumns, extraModels } from '../scripts/cf-additions.mjs';
import { classifyStoreColumns } from '../scripts/store-split.mjs';
import * as storeTables from '../src/store/schema.generated';
import * as platformTables from '../src/platform/schema.generated';
import { openDb, readJson, REPO } from './helpers';

type Info = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const split = readJson<Record<string, { target: string }>>('model-split.json');
const exceptions = readJson<{ renamedColumns: { table: string; column: string }[] }>(
  'parity-exceptions.json'
);
const manifest = readJson<{ decimals: { table: string; column: string; scale: number }[] }>(
  'generated/manifest.json'
);
const schema = parseSchema(
  fs.readFileSync(path.join(REPO, 'packages/database/prisma/schema.prisma'), 'utf8')
);
const dmmf = Prisma.dmmf.datamodel;
const dbs = { 'store-do': openDb('store'), d1: openDb('platform') };
const info = (target: 'store-do' | 'd1', table: string): Info[] =>
  dbs[target].prepare(`PRAGMA table_info("${table}")`).all() as Info[];

const AFFINITY: Record<string, string> = {
  String: 'TEXT',
  Int: 'INTEGER',
  BigInt: 'INTEGER',
  Float: 'REAL',
  Boolean: 'INTEGER',
  DateTime: 'INTEGER',
  Json: 'TEXT',
  Decimal: 'INTEGER',
};

// which emitted table(s) hold a Prisma model's columns
function tablesFor(modelName: string, target: 'store-do' | 'd1'): string[] {
  const m = schema.models.find(x => x.name === modelName)!;
  if (modelName === 'Store')
    return target === 'd1' ? ['stores'] : ['store_profile', 'store_config'];
  return [m.dbName];
}

describe('Prisma <-> SQLite parity', () => {
  for (const target of ['store-do', 'd1'] as const) {
    const models = Object.entries(split).filter(
      ([n, v]) => v.target === target || (n === 'Store' && target === 'store-do')
    );
    describe(target, () => {
      it('every Prisma column of every model is present with the right nullability, type class and default', () => {
        const problems: string[] = [];
        for (const [name] of models) {
          const m = schema.models.find(x => x.name === name)!;
          const d = dmmf.models.find(x => x.name === name)!;
          const tables = tablesFor(name, target);
          const cols = new Map(
            tables.flatMap(t => info(target, t).map(c => [`${t}.${c.name}`, c] as const))
          );
          const storeBuckets =
            name === 'Store'
              ? (classifyStoreColumns(
                  m.fields.filter(f => f.kind !== 'relation').map(f => f.name)
                ) as Record<string, string[]>)
              : null;
          for (const df of d.fields.filter(f => f.kind !== 'object')) {
            const pf = m.fields.find(f => f.name === df.name)!;
            const col = (df as { dbName?: string | null }).dbName ?? df.name;
            let candidates = tables;
            if (storeBuckets) {
              const inDo =
                storeBuckets.mirror.includes(df.name) || storeBuckets.profile.includes(df.name);
              candidates =
                target === 'd1'
                  ? storeBuckets.d1Only.includes(df.name) || storeBuckets.mirror.includes(df.name)
                    ? ['stores']
                    : []
                  : inDo
                    ? ['store_profile']
                    : storeBuckets.config.includes(df.name)
                      ? ['store_config']
                      : [];
            }
            if (candidates.length === 0) continue; // the column lives in the other database
            for (const t of candidates) {
              const c = cols.get(
                `${t}.${df.name === 'id' && name === 'Store' && target === 'store-do' ? 'store_id' : col}`
              );
              if (!c) {
                problems.push(`${name}.${df.name}: column ${t}.${col} missing`);
                continue;
              }
              const wantType = pf.list ? 'TEXT' : df.kind === 'enum' ? 'TEXT' : AFFINITY[df.type];
              if (c.type !== wantType)
                problems.push(`${t}.${col}: type ${c.type}, expected ${wantType}`);
              const required = pf.list ? true : !pf.optional; // the lean runtime DMMF has no isRequired; the parser is cross-checked against it in model-split.test.ts
              if (!!c.notnull !== required && c.pk === 0)
                problems.push(`${t}.${col}: notnull=${c.notnull}, Prisma required=${required}`);
              const hasDefault =
                pf.attrs.default !== undefined &&
                !String(pf.attrs.default).startsWith('uuid') &&
                !String(pf.attrs.default).startsWith('cuid');
              const wantsDefault = hasDefault || !!pf.attrs.updatedAt;
              if (wantsDefault && c.dflt_value === null)
                problems.push(
                  `${t}.${col}: Prisma default ${pf.attrs.default ?? '@updatedAt'} lost`
                );
              if (!wantsDefault && c.dflt_value !== null)
                problems.push(`${t}.${col}: default ${c.dflt_value} not in Prisma`);
              if (pf.attrs.default === 'false' && c.dflt_value !== '0')
                problems.push(`${t}.${col}: default false became ${c.dflt_value}`);
              if (pf.attrs.default === 'true' && c.dflt_value !== '1')
                problems.push(`${t}.${col}: default true became ${c.dflt_value}`);
              if (
                /^-?\d+$/.test(pf.attrs.default ?? '') &&
                pf.type !== 'Decimal' &&
                c.dflt_value !== pf.attrs.default
              )
                problems.push(`${t}.${col}: default ${pf.attrs.default} became ${c.dflt_value}`);
            }
          }
        }
        expect(problems).toEqual([]);
      });

      it('every SQLite column is a Prisma column, a declared addition, or a declared rename (no orphan columns)', () => {
        const known = new Set<string>();
        for (const [name] of models) {
          const m = schema.models.find(x => x.name === name)!;
          for (const t of tablesFor(name, target)) {
            for (const f of m.fields.filter(x => x.kind !== 'relation' && x.kind !== 'unsupported'))
              known.add(`${t}.${f.column}`);
            for (const f of (extraColumns as Record<string, { column: string }[]>)[name] ?? [])
              known.add(`${t}.${f.column}`);
          }
        }
        for (const x of (
          extraModels as Record<string, { dbName: string; fields: { column: string }[] }[]>
        )[target])
          for (const f of x.fields) known.add(`${x.dbName}.${f.column}`);
        for (const r of exceptions.renamedColumns) known.add(`${r.table}.${r.column}`);
        const orphans: string[] = [];
        for (const t of Object.keys(
          readJson<{ databases: Record<string, { columnCounts: Record<string, number> }> }>(
            'generated/manifest.json'
          ).databases[target].columnCounts
        )) {
          for (const c of info(target, t))
            if (!known.has(`${t}.${c.name}`)) orphans.push(`${t}.${c.name}`);
        }
        expect(orphans).toEqual([]);
      });
    });
  }

  it('every Decimal field is declared with its scale (nothing silently rounded)', () => {
    const prismaDecimals = schema.models
      .filter(m => ['store-do', 'd1'].includes(split[m.name].target))
      .flatMap(m => m.fields.filter(f => f.type === 'Decimal').map(f => `${m.dbName}.${f.column}`))
      .sort();
    // Store.default_tax_rate lives in the split config table (task 1.4)
    expect(
      manifest.decimals
        .map(d => `${d.table}.${d.column}`.replace('store_config.', 'stores.'))
        .sort()
    ).toEqual(prismaDecimals);
    expect(prismaDecimals.length).toBe(9);
  });
});

describe('Drizzle definitions match the SQLite catalog', () => {
  const sets = [
    ['store-do', storeTables],
    ['d1', platformTables],
  ] as const;
  for (const [target, mod] of sets) {
    it(`${target}: same tables, columns, nullability and primary keys`, () => {
      const exported = Object.values(mod).map(t => getTableConfig(t as SQLiteTable));
      const sqlTables = Object.keys(
        readJson<{ databases: Record<string, { columnCounts: Record<string, number> }> }>(
          'generated/manifest.json'
        ).databases[target].columnCounts
      ).sort();
      expect(exported.map(t => t.name).sort()).toEqual(sqlTables);
      for (const t of exported) {
        const cols = info(target, t.name);
        expect(t.columns.map(c => c.name).sort(), t.name).toEqual(cols.map(c => c.name).sort());
        for (const c of t.columns) {
          const sc = cols.find(x => x.name === c.name)!;
          expect(c.notNull || sc.pk > 0, `${t.name}.${c.name} notNull`).toBe(
            !!sc.notnull || sc.pk > 0
          );
          const pkCols = t.columns.filter(x => x.primary).map(x => x.name);
          const compositePk = t.primaryKeys.flatMap(p => p.columns.map(x => x.name));
          expect(pkCols.concat(compositePk).includes(c.name), `${t.name}.${c.name} pk`).toBe(
            sc.pk > 0
          );
        }
      }
    });
  }
});
