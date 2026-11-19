/**
 * trust_requests is on D1 (model-split.json): D1 has no RLS and the Prisma tenant guard does not run there, so the
 * filter in the query is the ONLY isolation. This scan is specific to the table (stricter than the generic
 * d1-tenant-filter-guard): every `trustRequest.<op>(...)` under apps/api/src must carry a `storeId` or `userId` KEY in
 * its `where` (a conditional `...(x ? { storeId } : {})` spread does not count: it can be absent), or be listed below
 * with the reason it spans tenants. Raw SQL on the table must filter by store_id / user_id too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../apps/api/src');

/** `<file>::<op>::<start of where>` -> why it may span tenants (every one is super-admin only). */
const SPANS_TENANTS: Record<string, string> = {
  'services/trust-requests.service.ts::findMany::{ kind: f.kind ?? { in: [...TRUST_KINDS] } }':
    'super-admin review list (route: authenticate + MFA + super_admin); optional storeId filter',
  'services/trust-requests.service.ts::findFirst::{ id, kind: { in: [...TRUST_KINDS] } }':
    'super-admin review by id; the id is the key, decisions then name the row own store / user',
  "services/trust-requests.service.ts::updateMany::{ kind: 'slug_claim', slug: grant.slug.trim().toLowerCase(), status: 'open' }":
    'a super-admin grant of a protected address closes every merchant open claim for it',
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return e.name.endsWith('.ts') && !e.name.includes('.test.') ? [p] : [];
  });
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');

function balanced(s: string, open: number, o: string, c: string): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
}
const squash = (t: string) =>
  t
    .replace(/\s+/g, ' ')
    .replace(/(,\s*)+/g, ', ')
    .replace(/, }/g, ' }')
    .trim();

const CALL =
  /\btrustRequest\s*\.\s*(findMany|findFirst|findUnique|count|update|updateMany|delete|deleteMany|upsert|aggregate|groupBy|create|createMany)\s*\(/g;

/** The `where` object of a call, with conditional spreads removed (they may be absent). */
export function whereOf(args: string): string | null {
  const i = args.search(/\bwhere\s*:/);
  if (i < 0) return null;
  const brace = args.indexOf('{', i);
  let w = balanced(args, brace, '{', '}');
  for (;;) {
    const sp = w.indexOf('...(');
    if (sp < 0) break;
    const end = balanced(w, sp + 3, '(', ')');
    w = w.slice(0, sp) + w.slice(sp + 3 + end.length);
  }
  return w;
}
export const namesTenant = (where: string | null) =>
  where !== null && /(^|[{,\s])(storeId|userId)\s*[:,}]/.test(where);

describe('trust_requests on D1: every query names a store or a user (or is a listed super-admin span)', () => {
  const files = walk(SRC);
  const calls = files.flatMap(f => {
    const s = fs.readFileSync(f, 'utf8');
    return [...s.matchAll(CALL)].map(m => {
      const args = balanced(s, m.index! + m[0].length - 1, '(', ')');
      return { file: rel(f), op: m[1], where: whereOf(args), args };
    });
  });

  it('the scan finds the calls (a broken regex must not read as green)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(15);
  });

  it('every filtered call has a storeId / userId key, or is listed with a reason', () => {
    const filtered = calls.filter(c => !['create', 'createMany'].includes(c.op));
    const bad: string[] = [];
    const used = new Set<string>();
    for (const c of filtered) {
      if (namesTenant(c.where)) continue;
      const key = `${c.file}::${c.op}::${squash(c.where ?? '(no where)').slice(0, 120)}`;
      if (key in SPANS_TENANTS) used.add(key);
      else bad.push(key);
    }
    expect(bad, 'a trust_requests query with neither a store_id nor a user_id filter').toEqual([]);
    expect(
      Object.keys(SPANS_TENANTS).filter(k => !used.has(k)),
      'stale entry: the call now names its tenant or is gone'
    ).toEqual([]);
  });

  it('every create sets a storeId or a userId (the row is always owned)', () => {
    const bad = calls
      .filter(c => c.op === 'create')
      .filter(c => !/\b(storeId|userId)\b/.test(c.args))
      .map(c => c.file);
    expect(bad).toEqual([]);
  });

  it('no raw SQL touches trust_requests without a store_id / user_id filter', () => {
    const bad: string[] = [];
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g)) {
        if (
          /\b(FROM|UPDATE|INTO|JOIN)\s+"?trust_requests"?\b/i.test(m[0]) &&
          !/store_id|user_id/i.test(m[0])
        )
          bad.push(rel(f));
      }
    }
    expect(bad).toEqual([]);
  });

  it('negative control: the scan flags an unfiltered and a conditionally filtered where', () => {
    expect(namesTenant(whereOf('{ where: { kind: "x" } }'))).toBe(false);
    expect(namesTenant(whereOf('{ where: { kind: "x", ...(f.s ? { storeId: f.s } : {}) } }'))).toBe(
      false
    );
    expect(namesTenant(whereOf('{ where: { kind: "x", storeId } }'))).toBe(true);
    expect(namesTenant(whereOf('{ where: { userId: u, kind: "x" } }'))).toBe(true);
  });
});
