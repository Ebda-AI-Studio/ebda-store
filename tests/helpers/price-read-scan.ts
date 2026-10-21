/**
 * AST scan for direct price reads under apps/api/src (design review section 7, Task 3 architecture test).
 * A "price read" is: a property access named `price` / `unitPrice` (incl. optional chaining), a destructured `{ price }`,
 * or a Prisma-style `price: true` select. Each hit reports the enclosing function / method name ("symbol") so an allow-list
 * can be keyed by file + symbol and does not rot when lines move.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface PriceRead {
  file: string; // relative to apps/api/src
  symbol: string;
  kind: 'access' | 'element' | 'destructure' | 'select' | 'raw';
  name: string;
  line: number;
}

const NAMES = new Set(['price', 'unitPrice']);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e === '__tests__' || e === 'workers-test') continue;
      walkFiles(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);

/**
 * The enclosing symbol. Express handlers are anonymous arrows, so a named-function lookup alone lumps a whole routes file
 * into one `<module>` bucket (design review M-4): a handler passed to `router.<method>('/path', ...)` is reported as
 * `METHOD /path`, which makes the per-symbol budget per route handler.
 */
function enclosingSymbol(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ROUTE_METHODS.has(n.expression.name.text) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      n.arguments.some(
        a =>
          a !== n.arguments[0] &&
          (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) &&
          contains(a, node)
      )
    ) {
      return `${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}`;
    }
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
      return n.name.getText();
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      return n.name.getText();
    }
    if (ts.isPropertyAssignment(n) && ts.isArrowFunction(n.initializer)) return n.name.getText();
  }
  return '<module>';
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

const RAW_CALL = /\$(query|execute)Raw(Unsafe)?$/;
const RAW_PRICE = /\b(price|unit_price|price_minor|compare_at_price)\b/i;

export function scanPriceReads(apiSrc: string): PriceRead[] {
  const hits: PriceRead[] = [];
  for (const abs of walkFiles(apiSrc)) {
    hits.push(...scanSource(relative(apiSrc, abs), readFileSync(abs, 'utf8')));
  }
  return hits;
}

/** Scan one source text (also used by the test to prove the scanner itself can fail). */
export function scanSource(file: string, text: string): PriceRead[] {
  const hits: PriceRead[] = [];
  {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const add = (node: ts.Node, kind: PriceRead['kind'], name: string) =>
      hits.push({
        file,
        symbol: enclosingSymbol(node),
        kind,
        name,
        line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && NAMES.has(node.name.text))
        add(node, 'access', node.name.text);
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const n = (node.propertyName ?? node.name).getText();
        if (NAMES.has(n)) add(node, 'destructure', n);
      } else if (
        ts.isPropertyAssignment(node) &&
        NAMES.has(node.name.getText()) &&
        node.initializer.kind === ts.SyntaxKind.TrueKeyword
      ) {
        add(node, 'select', node.name.getText());
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        NAMES.has(node.argumentExpression.text)
      ) {
        // x['price'] / x["unitPrice"]
        add(node, 'element', node.argumentExpression.text);
      } else if (
        (ts.isTaggedTemplateExpression(node) && RAW_CALL.test(node.tag.getText())) ||
        (ts.isCallExpression(node) &&
          RAW_CALL.test(node.expression.getText()) &&
          node.arguments[0] &&
          (ts.isStringLiteralLike(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0])))
      ) {
        // raw SQL that names a price column
        const text = ts.isTaggedTemplateExpression(node)
          ? node.template.getText()
          : (node as ts.CallExpression).arguments[0]!.getText();
        if (RAW_PRICE.test(text)) add(node, 'raw', 'price');
      } else if (ts.isShorthandPropertyAssignment(node) && NAMES.has(node.name.text)) {
        // `{ price }` as a value read of a local named price
        add(node, 'access', node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}
