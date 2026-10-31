// Differential harness: the same fixture goes into real Prisma/Postgres and into the StoreDO schema on
// SQLite; a query then runs through both and the results must be deeply equal. Local/CI with a Postgres only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createPrismaClient } from '../../database/src/client';
import { createPrismaLite } from '../src/prisma-lite/client';
import { encode } from '../src/prisma-lite/codec';
import { nodeSqlRunner } from './node-sql';
import type { Meta, ScalarField } from '../src/prisma-lite/types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const META = JSON.parse(
  fs.readFileSync(path.join(here, '../../cf-schema/generated/prisma-meta.json'), 'utf8')
) as Meta;
const STORE_SQL = fs.readFileSync(
  path.join(here, '../../cf-schema/migrations/store/0001_init.sql'),
  'utf8'
);

export const PG_URL = process.env.PRISMALITE_PG_URL;

export function openSqlite(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); // Store/User FKs are not emitted in the DO schema (other database), so ON only enforces in-DO FKs
  db.exec(STORE_SQL);
  // A real DO store always has its `store_profile` row (the settings write-through needs it), and an order's sale document reads the
  // seller from it (Ruling CF-R2-1). Test worlds that do not care get a default one the first time an order is written.
  db.exec(
    `CREATE TRIGGER test_seed_store_profile BEFORE INSERT ON orders BEGIN
       INSERT OR IGNORE INTO store_profile (store_id, name, slug, owner_id) VALUES (NEW.store_id, 'Test shop', NEW.store_id, 'test-owner');
     END`
  );
  return db;
}

/** Insert fixture rows (Prisma-shaped objects) into SQLite through the metadata codecs. */
export function insertSqlite(
  db: DatabaseSync,
  model: string,
  rows: Record<string, unknown>[]
): void {
  const m = META.models[model];
  for (const row of rows) {
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(row)) {
      const f = m.fields[k];
      if (!f || f.kind === 'relation') continue;
      cols.push(`"${(f as ScalarField).column}"`);
      vals.push(encode(f as ScalarField, v));
    }
    db.prepare(
      `INSERT INTO "${m.table}" (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    ).run(...(vals as never[]));
  }
}

export async function makePair() {
  const prisma = createPrismaClient({ role: 'owner', connectionString: PG_URL!, max: 2 });
  const db = openSqlite();
  const lite = createPrismaLite(META, nodeSqlRunner(db), 'store-do', { unscoped: true });
  return { prisma, db, lite, close: () => prisma.$disconnect() };
}

/** Canonicalise: Decimal -> string, Date -> ISO, undefined dropped, so deep-equal compares meaning. */
export function canon(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (
    v &&
    typeof v === 'object' &&
    typeof (v as { toFixed?: unknown }).toFixed === 'function' &&
    'd' in (v as object)
  )
    return `dec:${(v as { toString(): string }).toString()}`;
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, canon(x)])
    );
  return v;
}
