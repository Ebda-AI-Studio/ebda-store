/**
 * Cutover gate (Ruling CF-WRITES-3, closes the residual of CF-WRITES-2): every write to the `Store` row goes through
 * the settings write-through, so the StoreDO's copy (`store_profile` / `store_config`) can never drift from the
 * authoritative row.
 *
 * Allowed shapes, found with the TypeScript AST (not a grep, so a multi-line call or an alias cannot slip by):
 *  - `storeUpdate(db, args)` / `storeUpdateMany(db, args)` (`lib/repo-factory.ts`): the site no longer contains `.store.update(`;
 *  - `.store.update(...)` lexically INSIDE `updateStoreThrough(storeId, tx => ...)` (`StoreService`);
 *  - a raw `UPDATE stores` inside a function that also calls `syncStoreFields(...)` (re-reads the changed columns, copies them).
 * A direct `prisma.store.update|updateMany|upsert(...)` or `tx.store.update(...)` anywhere else in `apps/api/src` fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../apps/api/src');
/**
 * the helpers themselves hold the one real `db.store.update(`; the reconciler's raw statement writes the D1 DIRECTORY row of a `do`
 * store (restrictive direction only, Ruling NZ-D14), never the Postgres Store row this gate protects
 */
const ALLOWLIST = new Set(['lib/repo-factory.ts', 'lib/store-directory-reconcile.ts']);
const WRITES = new Set(['update', 'updateMany', 'upsert']);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.tsx?$/.test(e.name) &&
      !/\.(test|spec)\.tsx?$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
      ? [p]
      : [];
  });
}

function callee(n: ts.CallExpression): string | undefined {
  const e = n.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

export function findUnrouted(source: string, rel = 'x.ts'): string[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      WRITES.has(n.expression.name.text) &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === 'store'
    ) {
      let p: ts.Node | undefined = n.parent;
      let routed = false;
      while (p) {
        if (ts.isCallExpression(p) && callee(p) === 'updateStoreThrough') routed = true;
        p = p.parent;
      }
      if (!routed) out.push(`${at(n)} store.${n.expression.name.text}`);
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) &&
      /\bUPDATE\s+"?stores"?\b/i.test(n.getText())
    ) {
      // the OUTERMOST enclosing function: the raw write often sits in a `withStore(id, tx => ...)` arrow inside the method
      let fn: ts.Node | undefined;
      for (let a: ts.Node | undefined = n.parent; a; a = a.parent) if (ts.isFunctionLike(a)) fn = a;
      let synced = false;
      const scan = (m: ts.Node) => {
        if (ts.isCallExpression(m) && callee(m) === 'syncStoreFields') synced = true;
        ts.forEachChild(m, scan);
      };
      if (fn) scan(fn);
      if (!synced) out.push(`${at(n)} raw UPDATE stores`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('store settings are written through (CF-WRITES-3)', () => {
  it('no direct Store write outside the write-through', () => {
    const bad: string[] = [];
    for (const f of files(ROOT)) {
      const rel = path.relative(ROOT, f);
      if (ALLOWLIST.has(rel)) continue;
      bad.push(...findUnrouted(fs.readFileSync(f, 'utf8'), rel));
    }
    expect(bad).toEqual([]);
  });

  it('the detector sees each bypass shape (negative control)', () => {
    expect(findUnrouted('prisma.store.update({where:{id},data:{name}})')).toHaveLength(1);
    expect(findUnrouted('withStore(id, tx => tx.store.updateMany({}))')).toHaveLength(1);
    expect(findUnrouted('x.store\n  .upsert({})')).toHaveLength(1);
    expect(findUnrouted('updateStoreThrough(id, tx => tx.store.update({}))')).toHaveLength(0);
    expect(
      findUnrouted('async function f(){ await db.$executeRaw`UPDATE stores SET a=1`; }')
    ).toHaveLength(1);
    expect(
      findUnrouted(
        'async function f(){ await db.$executeRaw`UPDATE stores SET a=1`; await syncStoreFields(id,["settings"]); }'
      )
    ).toHaveLength(0);
  });
});
