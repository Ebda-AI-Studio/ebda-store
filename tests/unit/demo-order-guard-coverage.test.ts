/**
 * Ruling B1-13 / plan amendment C12: every order-creating path in the API passes the demo-store
 * (and plan) gate `assertOrderAllowed` BEFORE it writes the order.
 *
 * Parsed, not grepped: each order `create` call is located with the TypeScript AST and attributed
 * to its NAMED owner (a class method, a function declaration, or a route handler
 * `router.<verb>('<path>')`), skipping the inner closures (`withMoneyTx(prisma, async tx => …)`,
 * `decrementTrackedStock = async …`) that sit between them. The set of owners is pinned to
 * exactly three; each owner must CALL `assertOrderAllowed(` (a call expression, not a comment)
 * at a position before its create. An order create is any of `<x>.order.create(`,
 * `<x>['order'].create(`, or `order.create(` on a destructured `order`. Any other way to write an
 * order row (`order.upsert`, `order.createMany`, a nested `order:`/`orders: { create }`, raw
 * `INSERT INTO [public.]orders`) fails the suite, so a fourth path cannot appear without being
 * added here, gated, and reviewed. The last block runs the scanner on a committed probe so the
 * mutation evidence lives in the test, not only in a report.
 *
 * Limit (known, accepted): "guarded" is positional (the guard call appears earlier in the owner),
 * not control-flow dominance; the integration suite (`tests/integration/demo-store.test.ts`) is
 * what proves each path really refuses.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');

/** Node-20-compatible recursive walk (no fs.globSync). */
function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory())
      return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(rel);
    return /\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) ? [rel] : [];
  });
}

type Site = { file: string; owner: string; guardedBefore: boolean };
type Scan = { sites: Site[]; otherWrites: string[] };

const RAW_INSERT = /\binsert\s+into\s+(?:"?public"?\s*\.\s*)?"?orders"?(?![\w"])/i;
const NESTED_CREATE = /\borders?\s*:\s*\{\s*(?:create|createMany|connectOrCreate|upsert)\s*:/;

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

/** `x.order`, `x['order']`, or a bare (destructured) `order` identifier. */
function isOrderDelegate(e: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'order';
  if (ts.isElementAccessExpression(e))
    return ts.isStringLiteralLike(e.argumentExpression) && e.argumentExpression.text === 'order';
  return ts.isIdentifier(e) && e.text === 'order';
}

function scan(files: Array<{ file: string; src: string }>): Scan {
  const sites: Site[] = [];
  const otherWrites: string[] = [];
  for (const { file, src } of files) {
    if (RAW_INSERT.test(src)) otherWrites.push(`${file}: raw INSERT INTO orders`);
    if (NESTED_CREATE.test(src)) otherWrites.push(`${file}: nested order(s): { create }`);
    if (!/\border\b/.test(src)) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        isOrderDelegate(node.expression.expression)
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
          sites.push({ file, owner: owner?.label ?? `<no named owner at ${at}>`, guardedBefore });
        } else if (/^(upsert|createMany|createManyAndReturn)$/.test(method)) {
          otherWrites.push(`${at}: order.${method}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { sites, otherWrites };
}

const { sites, otherWrites } = scan(
  walk('apps/api/src').map(file => ({ file, src: readFileSync(path.join(root, file), 'utf8') }))
);

describe('demo store: every order-creating path calls assertOrderAllowed first (B1-13, C12)', () => {
  it('the order create sites are exactly the two known owners', () => {
    expect(sites.map(s => `${s.file} → ${s.owner}`).sort()).toEqual(
      [
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

describe('the scanner catches every shape it claims to (committed probe)', () => {
  const probe = `
    export async function guarded(prisma: any, storeId: string) {
      await assertOrderAllowed(storeId);
      return prisma.order.create({ data: {} });
    }
    export async function guardAfter(prisma: any, storeId: string) {
      const o = await prisma.order.create({ data: {} });
      await assertOrderAllowed(storeId);
      return o;
    }
    export async function destructured(tx: any) {
      const { order } = tx;
      return order.create({ data: {} });
    }
    export async function bracket(tx: any) {
      return tx['order'].create({ data: {} });
    }
    export async function upserts(tx: any) {
      await tx.order.upsert({});
      await tx.order.createMany({ data: [] });
    }
    export async function nestedSingular(tx: any) {
      return tx.orderItem.create({ data: { order: { create: { storeId: 's' } } } });
    }
    export async function rawPublic(tx: any) {
      return tx.$executeRawUnsafe('INSERT INTO public.orders (id) VALUES (1)');
    }
    export async function rawQuoted(tx: any) {
      return tx.$executeRaw\`insert into "public"."orders" (id) values (1)\`;
    }
    const anonymous = async (tx: any) => tx.order.create({ data: {} });
  `;
  const one = (src: string) => scan([{ file: 'probe.ts', src }]);
  const r = one(probe);

  it('attributes and judges each create', () => {
    const by = Object.fromEntries(r.sites.map(s => [s.owner, s.guardedBefore]));
    expect(by.guarded).toBe(true);
    expect(by.guardAfter).toBe(false); // a guard AFTER the write does not count
    expect(by.destructured).toBe(false);
    expect(by.bracket).toBe(false);
    expect(r.sites.some(s => s.owner.startsWith('<no named owner'))).toBe(true);
  });

  it('flags upsert / createMany', () => {
    expect(r.otherWrites).toEqual(
      expect.arrayContaining(['probe.ts:19: order.upsert', 'probe.ts:20: order.createMany'])
    );
  });

  it('flags a nested create through the singular order relation and raw INSERTs, quoted or schema-qualified', () => {
    expect(one('x({ data: { order: { create: {} } } })').otherWrites).toHaveLength(1);
    expect(one('x({ data: { orders: { connectOrCreate: {} } } })').otherWrites).toHaveLength(1);
    expect(one("raw('INSERT INTO orders (id) VALUES (1)')").otherWrites).toHaveLength(1);
    expect(one("raw('INSERT INTO public.orders (id)')").otherWrites).toHaveLength(1);
    expect(one('raw(`insert into "public"."orders" (id)`)').otherWrites).toHaveLength(1);
  });

  it('does not flag look-alikes (order_items, orderBy, sortOrder)', () => {
    expect(one("raw('INSERT INTO order_items (id) VALUES (1)')").otherWrites).toEqual([]);
    expect(one("raw('INSERT INTO orders_archive (id)')").otherWrites).toEqual([]);
    expect(
      one('find({ orderBy: { createdAt: "desc" } }); x({ sortOrder: 1 })').otherWrites
    ).toEqual([]);
  });
});
