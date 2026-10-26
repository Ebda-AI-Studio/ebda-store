// Task 1.5: every Postgres FUNCTION/TRIGGER in the migrations is mapped to its Cloudflare replacement.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PKG, REPO } from './helpers';

type Entry = { target: string; replacement: string; test?: string };
const fnMap = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/cf/fn-map.json'), 'utf8')) as Record<
  string,
  Entry
>;
const migDir = path.join(REPO, 'packages/database/prisma/migrations');

function definitions(): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(migDir)) {
    const p = path.join(migDir, d, 'migration.sql'); // rollback.sql copies are excluded on purpose
    if (!fs.existsSync(p)) continue;
    for (const m of fs
      .readFileSync(p, 'utf8')
      .matchAll(
        /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER)\s+"?(?:public\.)?([A-Za-z0-9_]+)"?/gim
      ))
      out.push(m[1]);
  }
  return out;
}

describe('docs/cf/fn-map.json', () => {
  const defs = definitions();
  const names = [...new Set(defs)].sort();

  it('finds the 89 definitions (82 distinct names; several are redefinitions, one legacy bridge function was dropped by 20261103000100)', () => {
    expect(defs.length).toBe(89);
    expect(names.length).toBe(82);
  });

  it('maps every defined name, and names nothing that is not defined (a new SQL function fails until mapped)', () => {
    expect(Object.keys(fnMap).sort()).toEqual(names);
  });

  it('every entry has a target, a non-empty replacement, and a test path or deleted-by-construction', () => {
    for (const [name, e] of Object.entries(fnMap)) {
      expect(
        ['store-do', 'd1', 'identity', 'analytics', 'deleted-by-construction'],
        name
      ).toContain(e.target);
      expect(e.replacement.trim().length, name).toBeGreaterThan(10);
      if (e.target !== 'deleted-by-construction')
        expect((e.test ?? '').length, name).toBeGreaterThan(0);
    }
  });

  // Audit DB-3 / M-045 (2026-10-26): fn-map named 17 contract-test files that existed on no branch, so the map
  // read as "every function has a test". A named test must exist and contain `it(`; everything else is on an
  // explicit list that the cutover gate (scripts/ci/assert-fn-ported.mjs) refuses to run with.
  const unportedFile = JSON.parse(
    fs.readFileSync(path.join(REPO, 'docs/cf/fn-unported.json'), 'utf8')
  ) as { unported: string[] };
  const hasRealTest = (e: Entry) => {
    if (!e.test) return false;
    const p = path.join(REPO, e.test);
    return fs.existsSync(p) && /\b(it|test)\(/.test(fs.readFileSync(p, 'utf8'));
  };
  const needsTest = (e: Entry) => !['identity', 'deleted-by-construction'].includes(e.target);

  it('docs/cf/fn-unported.json is exactly the entries without a real test file (it only shrinks when a test lands)', () => {
    const derived = Object.entries(fnMap)
      .filter(([, e]) => needsTest(e) && !hasRealTest(e))
      .map(([n]) => n)
      .sort();
    expect(unportedFile.unported).toEqual(derived);
  });

  it('every entry whose test already exists in this package points at a real file', () => {
    for (const [name, e] of Object.entries(fnMap)) {
      if (e.test && e.test.startsWith('packages/cf-schema/'))
        expect(fs.existsSync(path.join(REPO, e.test)), `${name} -> ${e.test}`).toBe(true);
    }
    expect(PKG).toContain('cf-schema');
  });
});
