/**
 * Finds every Prisma read of the `product` model, or of a relation that HYDRATES a product (`targetProduct`, `product1`,
 * `product2`, `product:`), inside the storefront-facing files, and reports whether the read carries the audience filter
 * (`audience` / `visibleProductWhere`). Companion of raw-product-sql-scan.ts: a wholesale-only product must not reach an
 * anonymous shopper through ANY read, raw or Prisma (review C1: recommendations hydrated related products unfiltered).
 */
import ts from 'typescript';

export interface PrismaProductRead {
  file: string;
  symbol: string;
  line: number;
  kind: string;
  hasAudience: boolean;
}

const READ_METHODS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'count',
  'groupBy',
  'aggregate',
]);
const HYDRATING_KEYS = new Set(['targetProduct', 'product1', 'product2']);
const AUD = /\baudience\b|visibleProductWhere/;

function symbolOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
      return n.name.getText();
    if (ts.isVariableDeclaration(n)) return n.name.getText();
  }
  return '<module>';
}

export function scanPrismaProductReads(file: string, text: string): PrismaProductRead[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: PrismaProductRead[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const m = node.expression.name.text;
      const target = node.expression.expression.getText();
      if (READ_METHODS.has(m) && /\.product$/.test(target)) {
        out.push({
          file,
          symbol: symbolOf(node),
          line: line(node),
          kind: `product.${m}`,
          hasAudience: AUD.test(node.getText()),
        });
      }
      // a relation read (productRelation / aiRecommendation / frequentlyBoughtTogether ...) that selects a hydrating key
      if (READ_METHODS.has(m)) {
        const body = node.arguments.map(a => a.getText()).join(',');
        for (const key of HYDRATING_KEYS) {
          if (new RegExp(`\\b${key}\\b`).test(body)) {
            out.push({
              file,
              symbol: symbolOf(node),
              line: line(node),
              kind: `${target.split('.').pop()}.${m}->${key}`,
              hasAudience: AUD.test(body),
            });
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
