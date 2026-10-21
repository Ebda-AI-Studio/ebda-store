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
  kind: 'access' | 'destructure' | 'select';
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

function enclosingSymbol(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
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
