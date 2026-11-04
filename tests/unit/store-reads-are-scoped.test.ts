/**
 * Every read or write of the `stores` row outside a route handler runs in a scope
 * (R-EBDA-003 / R-EBDA-005).
 *
 * `stores` is under strict RLS and the code-level tenant guard refuses a `Store` query that is
 * not keyed to the ambient store (or owner). Inngest functions, crons and services are reached
 * with no request scope, and the integration suite runs them in-process on the OWNER client
 * (no guard), so a contextless `prisma.store.findUnique` there passes every integration test and
 * throws in production. This source scan closes that blind spot: in apps/api/src/{lib,services,
 * mcp,middleware,utils}, every `prisma.store.*` call must sit lexically inside a scope call
 * (`withStore`, `runInStoreScope`, `runInTenantContext`, `acrossStores`, `withUser`,
 * `asPlatformOperator`, `scopeTransaction`, ...) or be on the reviewed allow-list below.
 * A pre-scope read goes through a definer in apps/api/src/lib/definer.ts instead.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['lib', 'services', 'mcp', 'middleware', 'utils'].map(d =>
  path.join(ROOT, 'apps/api/src', d)
);
const SCOPES =
  /^(withStore|runInStoreScope|runInTenantContext|acrossStores|acrossStoresFlat|withUser|asPlatformOperator|asOperator|scopeTransaction|readInStoreContext|withTenantContext|pageAcrossStores|sweepAcrossStores)$/;

/** `file::function` that run only under a caller's scope, with the reason. */
const ALLOWED: Record<string, string> = {
  'apps/api/src/services/ci-hints.service.ts::ciOverview':
    'only called from GET /stores/:storeId/ci/overview, behind requireStoreAccess (the request scope)',
  'apps/api/src/services/ci-hints.service.ts::setCiSharing':
    'only called from PUT /stores/:storeId/ci/sharing, behind requireStoreAccess (the request scope)',
  'apps/api/src/services/page-builder.service.ts::publisherNames':
    'only reached from listRevisions, behind the page-builder routes (requireStoreAccess opens the request scope)',
  'apps/api/src/services/store.service.ts::list':
    'GET /stores runs it under withUser (owner) or asPlatformOperator (super_admin)',
  'apps/api/src/services/provisioning.service.ts::listStores':
    'the admin router runs it under the platform-operator hatch or the owner user scope',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function unscopedStoreCalls(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rel = path.relative(ROOT, file);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === 'store' &&
      n.expression.expression.expression.getText() === 'prisma'
    ) {
      let p: ts.Node | undefined = n.parent;
      let scoped = false;
      let fn = '?';
      while (p) {
        if (ts.isCallExpression(p) && SCOPES.test(p.expression.getText().split('.').pop() ?? '')) {
          scoped = true;
          break;
        }
        if (fn === '?' && (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
          fn = p.name.getText();
        }
        p = p.parent;
      }
      if (!scoped && !(`${rel}::${fn}` in ALLOWED)) {
        const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        found.push(`${rel}:${line} prisma.store.${n.expression.name.text} [${fn}]`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
}

describe('store reads outside route handlers run in a scope', () => {
  it('the detector flags a contextless read and accepts a scoped one (positive control)', () => {
    const bad = unscopedStoreCalls(
      path.join(ROOT, 'apps/api/src/lib/x.ts'),
      `async function f(id: string) { return prisma.store.findUnique({ where: { id } }); }`
    );
    expect(bad).toHaveLength(1);
    const good = unscopedStoreCalls(
      path.join(ROOT, 'apps/api/src/lib/x.ts'),
      `async function f(id: string) { return withStore(id, () => prisma.store.findUnique({ where: { id } })); }`
    );
    expect(good).toEqual([]);
  });

  it('no unscoped prisma.store call in lib / services / mcp / middleware / utils', () => {
    const offenders = DIRS.flatMap(d => sourceFiles(d)).flatMap(f =>
      unscopedStoreCalls(f, fs.readFileSync(f, 'utf8'))
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every allow-listed function still exists', () => {
    for (const key of Object.keys(ALLOWED)) {
      const [rel, fn] = key.split('::');
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(text, key).toMatch(new RegExp(`\\b${fn}\\s*\\(`));
    }
  });
});
