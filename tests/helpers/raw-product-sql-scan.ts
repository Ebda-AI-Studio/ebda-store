/**
 * Finds every raw SQL statement in apps/api/src that READS the products table (FROM / JOIN products), so the wholesale-only
 * visibility predicate cannot be forgotten in one (B2B Task 6, Ruling B2B-7b and the raw-SQL checklist: a hidden product that
 * is filtered AFTER a LIMIT occupies result slots and leaks through counts).
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface RawProductQuery {
  file: string;
  symbol: string;
  line: number;
  /** The statement text mentions the `audience` column. */
  hasAudiencePredicate: boolean;
}

const READS_PRODUCTS = /\b(FROM|JOIN)\s+(public\.)?"?products"?(?![_\w])/i;
const RAW_TAG = /(\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe|Prisma\.sql|\bsql)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e === '__tests__') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function symbolOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
      return n.name.getText();
    if (ts.isVariableDeclaration(n)) return n.name.getText();
  }
  return '<module>';
}

export function scanSourceForProductSql(file: string, text: string): RawProductQuery[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: RawProductQuery[] = [];
  const consider = (node: ts.Node, body: string) => {
    if (!READS_PRODUCTS.test(body)) return;
    hits.push({
      file,
      symbol: symbolOf(node),
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      hasAudiencePredicate: /\baudience\b/i.test(body),
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node) && RAW_TAG.test(node.tag.getText())) {
      consider(node, node.template.getText());
    } else if (
      ts.isCallExpression(node) &&
      RAW_TAG.test(node.expression.getText()) &&
      node.arguments[0] &&
      (ts.isStringLiteralLike(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]))
    ) {
      consider(node, node.arguments[0].getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

export function scanRawProductQueries(apiSrc: string): RawProductQuery[] {
  return walk(apiSrc).flatMap(abs =>
    scanSourceForProductSql(relative(apiSrc, abs), readFileSync(abs, 'utf8'))
  );
}

/** SQL FUNCTIONS in migrations that read products (CREATE FUNCTION body mentions FROM/JOIN products). */
export function scanMigrationFunctions(
  migrationsDir: string
): Array<{ migration: string; hasAudiencePredicate: boolean }> {
  const out: Array<{ migration: string; hasAudiencePredicate: boolean }> = [];
  for (const dir of readdirSync(migrationsDir)) {
    const f = join(migrationsDir, dir, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of sql.matchAll(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION[\s\S]*?\$(\w*)\$[\s\S]*?\$\2\$/gi
    )) {
      if (READS_PRODUCTS.test(m[0]))
        out.push({ migration: dir, hasAudiencePredicate: /\baudience\b/i.test(m[0]) });
    }
  }
  return out;
}
