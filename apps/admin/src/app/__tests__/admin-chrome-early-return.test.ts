/**
 * Class guard for audit 2026-09-30 §8 ("Discount Coupons looks like it
 * navigates away and back").
 *
 * Every admin page renders its own <AdminLayout> (sidebar, hub tabs, topbar).
 * A page that returns ANYTHING ELSE first — a loading spinner, a "not found"
 * line — unmounts that chrome for as long as the early return holds, and the
 * merchant sees the admin vanish and reappear. It was found in 4 pages
 * (coupons, branding, marketing-pixels, template), and one editor (blog
 * post) rendered with no chrome at all.
 *
 * This walks every .tsx under apps/admin/src/app with the TypeScript AST:
 *
 *  1. In any function that returns <AdminLayout>, every OTHER return must be
 *     `null`, a component whose own module renders <AdminLayout> (e.g.
 *     ProductsLoadingSkeleton, StoreErrorState), or `gate` — accepted ONLY
 *     because FeatureUpgradeGate itself renders <AdminLayout> (pinned below;
 *     it used to be a bare card that dropped the chrome, #2236).
 *  2. Every store page (`app/stores/[id]/**\/page.tsx`) must reach
 *     <AdminLayout> — directly or through an imported component — unless it
 *     is a redirect.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../..');
const APP = path.join(SRC, 'app');

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

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const cand of [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Local name → resolved file, for every relative / `@/` import. */
function importMap(file: string, sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = (st.moduleSpecifier as ts.StringLiteral).text;
    const resolved = resolveImport(file, spec);
    if (!resolved) continue;
    const { name, namedBindings } = st.importClause;
    if (name) map.set(name.text, resolved);
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const el of namedBindings.elements) map.set(el.name.text, resolved);
    }
  }
  return map;
}

const rendersLayoutCache = new Map<string, boolean>();
function moduleRendersLayout(file: string): boolean {
  if (!rendersLayoutCache.has(file)) {
    rendersLayoutCache.set(file, fs.readFileSync(file, 'utf8').includes('<AdminLayout'));
  }
  return rendersLayoutCache.get(file)!;
}

function jsxTagName(expr: ts.Expression): string | null {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isJsxElement(e)) return e.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(e)) return e.tagName.getText();
  return null;
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

function returnsOf(fn: ts.FunctionLikeDeclaration): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn && ts.isFunctionLike(n)) return; // nested callbacks own their returns
    if (ts.isReturnStatement(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}

const files = walk(APP);
const GATE_COMPONENT = path.join(SRC, 'components/FeatureUpgradeGate.tsx');

describe('admin chrome stays mounted (no early return before <AdminLayout>)', () => {
  it('finds admin pages to check (positive control)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // #2236 — `if (gate) return gate;` on every feature-gated page returns the
  // upsell card, so the card must carry the chrome itself.
  it('the feature upsell a gated page returns renders inside <AdminLayout>', () => {
    expect(moduleRendersLayout(GATE_COMPONENT)).toBe(true);
    const hook = fs.readFileSync(path.join(SRC, 'hooks/useRequireFeature.ts'), 'utf8');
    expect(hook).toMatch(/createElement\(FeatureUpgradeGate/);
  });

  it('every non-layout return beside an <AdminLayout> return keeps the chrome', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sf = parse(file);
      if (!sf.text.includes('<AdminLayout')) continue;
      const imports = importMap(file, sf);
      const visit = (n: ts.Node) => {
        if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).body) {
          const rets = returnsOf(n as ts.FunctionLikeDeclaration);
          const hasLayout = rets.some(
            r => r.expression && jsxTagName(r.expression) === 'AdminLayout'
          );
          if (hasLayout) {
            for (const r of rets) {
              if (!r.expression) continue;
              const text = r.expression.getText();
              if (text === 'null') continue;
              if (text === 'gate' && moduleRendersLayout(GATE_COMPONENT)) continue;
              const tag = jsxTagName(r.expression);
              if (tag === 'AdminLayout') continue;
              const target = tag ? imports.get(tag) : undefined;
              if (target && moduleRendersLayout(target)) continue;
              const line = sf.getLineAndCharacterOfPosition(r.getStart()).line + 1;
              offenders.push(
                `${path.relative(SRC, file)}:${line} → return ${text.slice(0, 60).replace(/\s+/g, ' ')}`
              );
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });

  it('every store page reaches <AdminLayout> unless it is a redirect', () => {
    const offenders: string[] = [];
    for (const file of files.filter(
      f =>
        f.includes(`${path.sep}stores${path.sep}[id]${path.sep}`) &&
        f.endsWith(`${path.sep}page.tsx`)
    )) {
      const sf = parse(file);
      const text = sf.text;
      if (text.includes('<AdminLayout')) continue;
      if (/\bredirect\(|router\.replace\(/.test(text)) continue;
      const imports = importMap(file, sf);
      const reaches = [...imports.entries()].some(
        ([name, target]) => text.includes(`<${name}`) && moduleRendersLayout(target)
      );
      if (!reaches) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
