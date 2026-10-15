/**
 * Ruling B1-13 / plan amendment C12: every order-creating path in the API passes the demo-store
 * (and plan) gate `assertOrderAllowed` BEFORE it writes the order.
 *
 * Parsed, not grepped: each `<x>.order.create(...)` call is located with the TypeScript AST and
 * attributed to its NAMED owner (a class method, a function declaration, or a route handler
 * `router.<verb>('<path>')`), skipping the inner closures (`withMoneyTx(prisma, async tx => …)`,
 * `decrementTrackedStock = async …`) that sit between them. The set of owners is pinned to
 * exactly three; each owner must CALL `assertOrderAllowed(` (a call expression, not a comment)
 * at a position before its create. Any other way to write an order row (`order.upsert`,
 * `order.createMany`, a nested `orders: { create }`, raw `INSERT INTO orders`) fails the suite,
 * so a fourth path cannot appear without being added here, gated, and reviewed.
 */
import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');
const files = globSync('apps/api/src/**/*.ts', { cwd: root }).filter(
  f => !/\.test\.ts$|\.spec\.ts$|__tests__/.test(f)
);

type Site = { file: string; owner: string; createAt: number; guardedBefore: boolean };

function ownerOf(node: ts.Node): { label: string; fn: ts.Node } | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) && n.name) {
      const cls = ts.isClassLike(n.parent) && n.parent.name ? n.parent.name.text : '?';
      return { label: `${cls}.${n.name.getText()}`, fn: n };
    }
    if (ts.isFunctionDeclaration(n) && n.name) return { label: n.name.text, fn: n };
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isCallExpression(n.parent) &&
      ts.isPropertyAccessExpression(n.parent.expression) &&
      /^(get|post|put|patch|delete|all)$/.test(n.parent.expression.name.text)
    ) {
      const route = n.parent.arguments[0];
      const p = route && ts.isStringLiteral(route) ? route.text : '?';
      return { label: `${n.parent.expression.getText()}('${p}')`, fn: n };
    }
  }
  return null;
}

const sites: Site[] = [];
const otherWrites: string[] = [];
for (const file of files) {
  const src = readFileSync(path.join(root, file), 'utf8');
  if (/\binsert\s+into\s+"?orders"?\b/i.test(src))
    otherWrites.push(`${file}: raw INSERT INTO orders`);
  if (/\borders\s*:\s*\{\s*create(Many)?\s*:/.test(src))
    otherWrites.push(`${file}: nested orders: { create }`);
  if (!src.includes('order.')) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'order'
    ) {
      const method = node.expression.name.text;
      const at = `${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      if (method === 'create') {
        const owner = ownerOf(node);
        let guardedBefore = false;
        const findGuard = (n: ts.Node) => {
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'assertOrderAllowed' &&
            n.getStart() < node.getStart()
          )
            guardedBefore = true;
          ts.forEachChild(n, findGuard);
        };
        if (owner) findGuard(owner.fn);
        sites.push({
          file,
          owner: owner?.label ?? `<no named owner at ${at}>`,
          createAt: node.getStart(),
          guardedBefore,
        });
      } else if (/^(upsert|createMany|createManyAndReturn)$/.test(method)) {
        otherWrites.push(`${at}: order.${method}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

describe('demo store: every order-creating path calls assertOrderAllowed first (B1-13, C12)', () => {
  it('the order.create sites are exactly the three known owners', () => {
    expect(sites.map(s => `${s.file} → ${s.owner}`).sort()).toEqual(
      [
        "apps/api/src/routes/payment-links.routes.ts → router.post('/')",
        'apps/api/src/services/order.service.ts → OrderService.create',
        'apps/api/src/services/order.service.ts → OrderService.createAdminOrder',
      ].sort()
    );
  });

  it('no other way to write an order row exists (upsert, createMany, nested create, raw INSERT)', () => {
    expect(otherWrites).toEqual([]);
  });

  it.each(sites.map(s => [`${s.file} → ${s.owner}`, s] as const))(
    '%s calls assertOrderAllowed before it creates the order',
    (_label, s) => expect(s.guardedBefore).toBe(true)
  );
});
