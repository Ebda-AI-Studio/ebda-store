/**
 * Search program Task 11: every product-TEXT writer keeps the embedding index current.
 *
 * Scans every `*.product.(create|createMany|update|updateMany|upsert)(...)` call in apps/api/src and
 * reads the TOP-LEVEL keys of its `data` object. A call is
 *   - text     — `data` names a column a vector is built from: the doc (name, nameAr,
 *                description, descriptionAr) or the words vector (searchTerms, SEARCH-T13-7);
 *   - dynamic  — `data` is an identifier, or has a spread / computed key at top level (may be text);
 *   - none     — anything else (stock, price, flags, positions...).
 * `status` and `deletedAt` count too: only active, non-deleted products are indexed (review M5).
 * Every file with a text or dynamic call is listed in REVIEWED with the exact count and how it
 * keeps the index current. A new text/dynamic call anywhere fails here until someone decides:
 * add `requestStoreReindex(...)` after the write commits, or record why it is not text.
 * Raw SQL that writes `products` is refused outright (none exists today).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'apps/api/src');
/** The embed doc's columns, plus what decides whether a product is indexed at all (review M5). */
const INDEX_FIELDS = new Set([
  'name',
  'nameAr',
  'searchTerms',
  'description',
  'descriptionAr',
  'status',
  'deletedAt',
]);

type Via = 'requestStoreReindex' | 'product.upserted';

const REVIEWED: Record<string, { sites: number; via: Via[] }> = {
  // create + update emit product.upserted (consumed by search-product-index); soft delete and
  // bulkUpdate (`scalarData`, when it carries status) request a reindex (review M5). The 5th site is
  // `updateOnDo`'s product row write: the Durable Object twin of `update`'s transaction, reached only from
  // `update`, which emits product.upserted after it either way (CF-WRITES-2).
  // the one-time name-pair repair (Ruling NAME-PAIR-1) emits product.upserted for every row it writes
  'apps/api/src/services/product-name-repair.service.ts': { sites: 1, via: ['product.upserted'] },
  'apps/api/src/services/product.service.ts': {
    sites: 5,
    via: ['product.upserted', 'requestStoreReindex'],
  },
  // writeAiFieldsGuarded (fill + balance) and revertProductBalance.
  'apps/api/src/services/ai-autofill.service.ts': { sites: 2, via: ['requestStoreReindex'] },
  // AI hand-back clears one field by computed key before regenerating it.
  'apps/api/src/routes/ai.routes.ts': { sites: 1, via: ['requestStoreReindex'] },
  // CSV/XLSX import create + update (`...productFields`), soft bulk delete, bulk status.
  'apps/api/src/services/bulk.service.ts': { sites: 4, via: ['requestStoreReindex'] },
  // AITOOLS-4: replace-with-backup (the translate sweep reindexes once per batch) and undo (reindexes once after restoring).
  'apps/api/src/services/catalogue-replace-backup.service.ts': {
    sites: 2,
    via: ['requestStoreReindex'],
  },
  // Catalogue translation sweep (`data: updates` = name/nameAr/description/descriptionAr).
  'apps/api/src/lib/inngest/functions/bulk-ai-translate.ts': {
    sites: 1,
    via: ['requestStoreReindex'],
  },
};

function listTs(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== '__tests__' && f !== 'node_modules') listTs(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Index of the bracket closing the one at `open` (skips strings and template literals). */
function closeOf(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Top-level comma-separated members of an object literal body. */
function topLevelMembers(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < body.length && body[i] !== c; i++) if (body[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map(m => m.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()).filter(Boolean);
}

export function classifyCall(args: string): 'text' | 'dynamic' | 'none' {
  const outer = topLevelMembers(
    args
      .slice(1, -1)
      .trim()
      .replace(/^\{|\}$/g, '')
  );
  const dataMember = outer.find(m => /^data\s*:/.test(m));
  if (!dataMember) return /^\s*\{/.test(args.slice(1)) ? 'none' : 'dynamic';
  const value = dataMember.replace(/^data\s*:\s*/, '');
  // `data: [...]` (createMany) → classify each element.
  const objects = value.startsWith('[') ? topLevelMembers(value.slice(1, -1)) : [value];
  let kind: 'text' | 'dynamic' | 'none' = 'none';
  for (const obj of objects) {
    if (!obj.startsWith('{')) return 'dynamic';
    for (const m of topLevelMembers(obj.slice(1, -1))) {
      if (m.startsWith('...') || m.startsWith('[')) kind = 'dynamic';
      const key = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(m)?.[1];
      if (key && INDEX_FIELDS.has(key)) return 'text';
    }
  }
  return kind;
}

/** Raw SQL that inserts products or SETs an index column of products (embed doc, status, deleted_at). */
export function rawProductWrites(src: string): string[] {
  const out: string[] = [];
  // Case-insensitive; the table may be quoted and carry an alias (`products p`, `products AS p`).
  const table = String.raw`"?products"?(?:\s+(?:AS\s+)?(?!SET\b)[A-Za-z_]\w*)?`;
  if (new RegExp(String.raw`INSERT\s+INTO\s+${table}\s*\(`, 'i').test(src)) out.push('INSERT');
  const update = new RegExp(
    String.raw`UPDATE\s+${table}\s+SET([\s\S]*?)(WHERE|RETURNING|\x60|$)`,
    'gi'
  );
  for (const m of src.matchAll(update)) {
    if (
      /(^|[\s,.])"?(name|name_ar|search_terms|description|description_ar|status|deleted_at)"?\s*=/i.test(
        m[1]
      )
    )
      out.push(`UPDATE ... SET ${m[1].trim().slice(0, 40)}`);
  }
  return out;
}

function scan(): Map<string, Array<{ line: number; kind: 'text' | 'dynamic' }>> {
  const CALL = /\.product\.(create|createMany|update|updateMany|upsert)\(/g;
  const hits = new Map<string, Array<{ line: number; kind: 'text' | 'dynamic' }>>();
  for (const file of listTs(SRC)) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(CALL)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(s, open);
      const kind = classifyCall(s.slice(open, close + 1));
      if (kind === 'none') continue;
      const rel = relative(ROOT, file);
      const line = s.slice(0, m.index).split('\n').length;
      hits.set(rel, [...(hits.get(rel) ?? []), { line, kind }]);
    }
  }
  return hits;
}

describe('product text writers keep the search index current (Task 11)', () => {
  const hits = scan();

  it('the classifier reads top-level data keys, not selects or nested objects', () => {
    expect(
      classifyCall('({ where: { id }, data: { inventory: 1 }, select: { name: true } })')
    ).toBe('none');
    expect(classifyCall('({ where: { id }, data: { excerpt: x, src: { ...s } } })')).toBe('none');
    expect(classifyCall('({ where: { id }, data: { nameAr: x } })')).toBe('text');
    expect(classifyCall('({ where: { id }, data: { [field]: null } })')).toBe('dynamic');
    expect(classifyCall('({ where: { id }, data: { ...fields, a: 1 } })')).toBe('dynamic');
    expect(classifyCall('({ where: { id }, data: updates })')).toBe('dynamic');
    expect(classifyCall('(args)')).toBe('dynamic');
  });

  it('every text/dynamic product writer is reviewed (a new one fails until decided)', () => {
    const found = Object.fromEntries([...hits.entries()].map(([f, sites]) => [f, sites.length]));
    const expected = Object.fromEntries(Object.entries(REVIEWED).map(([f, r]) => [f, r.sites]));
    expect(found).toEqual(expected);
  });

  it.each(Object.entries(REVIEWED).filter(([, r]) => r.via.includes('requestStoreReindex')))(
    '%s requests a reindex',
    f => {
      expect(readFileSync(join(ROOT, f), 'utf8')).toMatch(/requestStoreReindex\(/);
    }
  );

  it.each(Object.entries(REVIEWED).filter(([, r]) => r.via.includes('product.upserted')))(
    '%s emits product.upserted (the indexer consumes it)',
    f => {
      expect(readFileSync(join(ROOT, f), 'utf8')).toMatch(/name: 'product\.upserted'/);
    }
  );

  it('the indexer consumes product.upserted and the reindex event', () => {
    const fn = readFileSync(join(SRC, 'lib/inngest/functions/search-product-index.ts'), 'utf8');
    expect(fn).toMatch(/event: 'product\.upserted'/);
    expect(fn).toMatch(/event: REINDEX_EVENT/);
  });

  it('the raw-SQL detector catches lower case and table aliases (review M1)', () => {
    expect(rawProductWrites('update products set name = $1 where id = $2')).toHaveLength(1);
    expect(rawProductWrites('UPDATE products p SET name = $1 WHERE p.id = $2')).toHaveLength(1);
    expect(rawProductWrites('UPDATE "products" AS p SET "search_terms" = $1')).toHaveLength(1);
    expect(rawProductWrites('insert into products (id, name) values ($1, $2)')).toHaveLength(1);
    expect(rawProductWrites('insert into "products" p (id) values ($1)')).toHaveLength(1);
    expect(rawProductWrites('UPDATE "products" SET inventory = 1 WHERE "id" = $1')).toEqual([]);
    expect(rawProductWrites('update product_variants set name = $1')).toEqual([]);
  });

  it('no raw SQL inserts products or SETs an index column (it would bypass every check above)', () => {
    const bad = listTs(SRC).flatMap(f =>
      rawProductWrites(readFileSync(f, 'utf8')).map(w => `${relative(ROOT, f)}: ${w}`)
    );
    // Today: warehouse.service (inventory) and product.service (ai_field_sources) only.
    expect(bad).toEqual([]);
  });
});
