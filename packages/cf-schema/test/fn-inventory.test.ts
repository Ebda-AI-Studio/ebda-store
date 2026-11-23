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

  it('finds the 100 definitions (93 distinct names; one read-only inbox lookup came with NEON-ZERO N-10b; several are redefinitions, one legacy bridge function was dropped by 20261103000100, two came with WA-GRACE-1, three with FOUNDING-1, four fold-A functions with F7-HAMZA-2)', () => {
    expect(defs.length).toBe(100);
    expect(names.length).toBe(93);
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

  it('every entry whose test already exists in this package points at a real file', () => {
    for (const [name, e] of Object.entries(fnMap)) {
      if (e.test && e.test.startsWith('packages/cf-schema/'))
        expect(fs.existsSync(path.join(REPO, e.test)), `${name} -> ${e.test}`).toBe(true);
    }
    expect(PKG).toContain('cf-schema');
  });
});
