/**
 * Class guard for issues #2200/#2225 — `DataTable`'s `ariaLabel` prop was
 * optional, so no production call site passed one and every admin table was
 * announced to a screen reader as an unnamed table. `ariaLabel` is now
 * required on `DataTableProps` (see `../DataTable.tsx`), which makes `tsc`
 * enumerate every call site, but a required prop only proves SOME string was
 * passed — nothing stops a future caller from hardcoding
 * `ariaLabel="Orders"` instead of threading a translated label through.
 *
 * This walks every .tsx file under apps/admin/src with the TypeScript AST
 * (never a regex — a regex over source text would also match `<DataTable`
 * inside a comment or a string, and can't distinguish a string-literal
 * attribute value from an expression), finds every `<DataTable` JSX opening
 * (self-closing or not, with or without a generic type argument like
 * `<DataTable<Row>`), and asserts each one has an `ariaLabel` attribute
 * whose value is an EXPRESSION — a translation call, a prop, a template
 * literal with a substitution — never a bare (or braced) string literal.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(p, out);
    } else if (e.name.endsWith('.tsx') && !/\.test\.tsx$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

/** `DataTable`, `DataTable<Row>`, `Foo.DataTable` (never matched here, but
 *  kept simple: only the literal identifier `DataTable` counts). */
function isDataTableTag(tagName: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tagName) && tagName.text === 'DataTable';
}

interface Finding {
  file: string;
  line: number;
  ok: boolean;
  reason: string;
}

/** True when the JSX attribute value is a hardcoded string, not an
 *  expression — `ariaLabel="Orders"` or `ariaLabel={'Orders'}` or
 *  `ariaLabel={`Orders`}` (no substitutions). A template literal WITH a
 *  substitution (e.g. `` `type.${typeKey}` `` fed into a translator call)
 *  is not a plain literal itself — it's wrapped in a CallExpression by the
 *  time it reaches `ariaLabel`, so it never hits this branch directly. */
function isPlainStringLiteral(initializer: ts.JsxAttributeValue | undefined): boolean {
  if (!initializer) return true; // boolean-shorthand `ariaLabel` — not a string at all
  if (ts.isStringLiteral(initializer)) return true; // ariaLabel="Orders"
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    const expr = initializer.expression;
    if (ts.isStringLiteral(expr)) return true; // ariaLabel={"Orders"}
    if (ts.isNoSubstitutionTemplateLiteral(expr)) return true; // ariaLabel={`Orders`}
    return false;
  }
  return false;
}

function checkOpening(
  file: string,
  sf: ts.SourceFile,
  tagName: ts.JsxTagNameExpression,
  attributes: ts.JsxAttributes,
  pos: number
): Finding | null {
  if (!isDataTableTag(tagName)) return null;
  const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
  const attr = attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'ariaLabel'
  );
  if (!attr) {
    return { file, line, ok: false, reason: 'missing ariaLabel attribute' };
  }
  if (isPlainStringLiteral(attr.initializer)) {
    return {
      file,
      line,
      ok: false,
      reason: 'ariaLabel is a hardcoded string literal, not an expression',
    };
  }
  return { file, line, ok: true, reason: '' };
}

function findDataTableUsages(file: string): Finding[] {
  const sf = parse(file);
  const out: Finding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxSelfClosingElement(n)) {
      const f = checkOpening(file, sf, n.tagName, n.attributes, n.getStart());
      if (f) out.push(f);
    } else if (ts.isJsxOpeningElement(n)) {
      const f = checkOpening(file, sf, n.tagName, n.attributes, n.getStart());
      if (f) out.push(f);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const files = walk(SRC);
const findings = files.flatMap(findDataTableUsages);

describe('every <DataTable> call site passes a translated ariaLabel (#2200/#2225)', () => {
  it('finds DataTable usages to check (positive control)', () => {
    // 50 production call sites (2026-09-30 remediation) plus the two
    // dedicated render tests that pass a literal ariaLabel deliberately —
    // this file's own walk skips *.test.tsx, so it only ever sees the
    // production count. Guards against the walk silently matching nothing
    // (e.g. a broken glob) and the suite passing on zero evidence.
    expect(files.length).toBeGreaterThan(40);
    expect(findings.length).toBeGreaterThan(40);
  });

  it('every call site has an ariaLabel built from an expression, never a hardcoded string', () => {
    const offenders = findings.filter(f => !f.ok);
    const detail = offenders
      .map(f => `${path.relative(SRC, f.file)}:${f.line} — ${f.reason}`)
      .join('\n');
    expect(offenders, detail).toEqual([]);
  });
});
