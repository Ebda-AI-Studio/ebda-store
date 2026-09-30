/**
 * The id and foreign-key columns in this schema are TEXT (Prisma
 * `String @id @default(uuid())` maps to `text`, not `uuid`) — the only native
 * uuid columns are `ai_recommendation.id` and `product_daily_views.id`, which
 * no raw query compares against. A raw-SQL comparison `store_id = ${x}::uuid`
 * is therefore `text = uuid`, which Postgres rejects outright
 * ("operator does not exist: text = uuid") — the statement errors on EVERY
 * call, and inside the request transaction it takes the whole request down.
 *
 * Found 2026-09-30 in three places at once: the guest half of
 * `GET /customers/search`, the barcode "order fully picked" check, and a new
 * query in review. None had a test that reached the statement. This gate
 * fails on the pattern itself, so the class cannot come back unnoticed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../apps/api/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(p);
  }
  return out;
}

// `<something>_id = ${...}::uuid` or `id = ${...}::uuid` in a tagged template.
const TEXT_ID_UUID_CAST = /\b(?:[a-z_]*_)?id\s*=\s*\$\{[^}]+\}::uuid/g;

describe('raw SQL never casts a parameter to uuid against a TEXT id column', () => {
  it('finds no `<col>_id = ${x}::uuid` in apps/api/src', () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(TEXT_ID_UUID_CAST)) {
        hits.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the pattern catches the shape it guards (positive control)', () => {
    const sample = 'WHERE store_id = ${storeId}::uuid AND order_id = ${o}::uuid';
    expect(sample.match(TEXT_ID_UUID_CAST)).toHaveLength(2);
  });
});
