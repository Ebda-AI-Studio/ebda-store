/**
 * SIGN-1 guard (ebda-foundation design/DESIGN.md; formatter: packages/shared/src/region/signed.ts).
 *
 * AST-based (TypeScript compiler API) over every .ts/.tsx under apps/{admin,web,orders} + packages/ui.
 * There is NO exemption marker: a glyph that is not a number uses an explicit component or constant instead
 * (<PlusGlyph/>, <MinusGlyph/>, <Sep/> from @ebda/ui, or a named string constant).
 *
 * A "sign" is `-`, `\u2212` or `+` that stands at the edge of a text/literal, NOT glued to a word ("tier2-" is a
 * hyphen). Fails when:
 *   S1  a literal ending in a sign is concatenated with a non-literal (`'-' + fmt(x)`, `'Total: -' + n`), or a literal
 *       starting with a sign follows a non-literal (`x + '-5'`)
 *   S2  a template whose head ends in a sign: `-${n}`, `+${n}`, `Total -${n}`
 *   S3  a conditional choosing a sign literal against '' or another sign: `x > 0 ? '+' : ''`
 *   S4  a JSX expression child that is a sign literal followed by another child expression: `{'\u2212'}{x}`
 *   S5  JSX text ending in a sign followed by ANY expression/element (comments and `{' '}` included):
 *       `-{n}`, `- {n}`, `{t('refund')} \u2212{fmt(x)}`, `{' '}-{x}`, a JSX comment before the sign
 *   S6  JSX text starting with a sign after an expression/element: `{a} - {b}` (use <Sep/>)
 * Use <SignedNumber> (JSX) or formatSigned() (a string that cannot be markup).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '../..');
const DIRS = ['apps/admin/src', 'apps/web/src', 'apps/orders/src', 'packages/ui/src'];
const SIGNS = '+-\u2212';

/** Text ends in a sign that is not glued to a word. */
export function endsWithSign(text: string): boolean {
  const t = text.trimEnd();
  if (!t || !SIGNS.includes(t[t.length - 1]!)) return false;
  const before = t.slice(0, -1);
  // `--x` (a CSS custom property) and `tier2-` (a hyphen glued to a word) are not signs.
  return before === '' || (!/[\p{L}\p{N}]$/u.test(before) && !before.endsWith(t[t.length - 1]!));
}
/** Text starts with a sign that is not glued to a word. */
export function startsWithSign(text: string): boolean {
  const t = text.trimStart();
  if (!t || !SIGNS.includes(t[0]!)) return false;
  const after = t.slice(1);
  return after === '' || /^[\s\d]/.test(after);
}

const lit = (n: ts.Node): string | null =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
const unwrap = (n: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;
const isSignLit = (n: ts.Node): boolean => {
  const t = lit(unwrap(n));
  return t !== null && t.length === 1 && SIGNS.includes(t);
};
const isEmptyLit = (n: ts.Node): boolean => lit(unwrap(n)) === '';
const isPlainLiteral = (n: ts.Node): boolean => lit(n) !== null || ts.isNumericLiteral(n);
const isDynamicChild = (n: ts.Node | undefined): boolean =>
  !!n && (ts.isJsxExpression(n) || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n));

export interface Violation {
  line: number;
  rule: string;
  text: string;
}

export function signViolations(src: string, file = 'x.tsx'): Violation[] {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX
  );
  const lines = src.split('\n');
  const out: Violation[] = [];
  const add = (n: ts.Node, rule: string) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
    out.push({ line: line + 1, rule, text: (lines[line] ?? '').trim() });
  };

  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = unwrap(n.left);
      const r = unwrap(n.right);
      const lt = lit(l);
      const rt = lit(r);
      if (lt !== null && endsWithSign(lt) && !isPlainLiteral(r)) add(n, 'S1');
      else if (rt !== null && startsWithSign(rt) && !isPlainLiteral(l)) add(n, 'S1');
    }
    if (ts.isTemplateExpression(n) && endsWithSign(n.head.text)) add(n, 'S2');
    if (ts.isConditionalExpression(n)) {
      const a = n.whenTrue;
      const b = n.whenFalse;
      if ((isSignLit(a) && (isEmptyLit(b) || isSignLit(b))) || (isSignLit(b) && isEmptyLit(a)))
        add(n, 'S3');
    }
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      const kids = n.children;
      kids.forEach((k, i) => {
        const next = kids[i + 1];
        const prev = kids[i - 1];
        if (ts.isJsxExpression(k) && k.expression) {
          const t = lit(unwrap(k.expression));
          if (t !== null && endsWithSign(t) && isDynamicChild(next)) add(k, 'S4');
        }
        if (ts.isJsxText(k)) {
          if (endsWithSign(k.text) && isDynamicChild(next)) add(k, 'S5');
          else if (startsWithSign(k.text) && isDynamicChild(prev)) add(k, 'S6');
        }
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory())
      return n === 'node_modules' || n === '__tests__' || n === '.next' ? [] : walk(p);
    return /\.tsx?$/.test(n) && !/\.(test|spec)\.|\.d\.ts$/.test(n) ? [p] : [];
  });
}

describe('SIGN-1: no hand-built sign prefixes in UI source', () => {
  it('finds none under apps/{admin,web,orders} + packages/ui (.ts and .tsx)', () => {
    const bad = DIRS.flatMap(d =>
      walk(join(ROOT, d)).flatMap(f =>
        signViolations(readFileSync(f, 'utf8'), f).map(
          v => `${relative(ROOT, f)}:${v.line} ${v.rule} ${v.text}`
        )
      )
    );
    expect(bad).toEqual([]);
  });

  // Every shape the guard exists for. A new miss is added here FIRST, then the rule is widened.
  const BAD: Array<[string, string, string?]> = [
    ['S2', 'const a = <b>{row.delta >= 0 ? `+${row.delta}` : row.delta}</b>;'],
    ['S3', "const a = <b>{entry.amount > 0 ? '+' : '−'}</b>;"],
    ['S5', 'const a = <span>-{member.totalRedeemed}</span>;'],
    ['S5', 'const a = <dd>−{formatMoney(x)}</dd>;'],
    ['S3', "const a = <dd>{l.adjustment > 0 ? '-' : l.adjustment < 0 ? '+' : ''}</dd>;"],
    ['S2', 'function f() { return `-${pct.toFixed(1)}%`; }'],
    ['S4', "const a = <b>{'−'}{x}</b>;"],
    ['S4', 'const a = <b>{"-"}{n}</b>;'],
    ['S5', 'const a = <b>- {n}</b>;'],
    ['S5', 'const a = <b>-{ n }</b>;'],
    ['S5', 'const a = <b>\n  + {n}\n</b>;'],
    ['S5', 'const a = <b>−{" "}{x}</b>;'],
    ['S1', "const a = <b>{'+' + count}</b>;"],
    ['S1', "function f(x: number) { return '-' + formatMoney(x); }", 'h.ts'],
    ['S1', "export const label = (n: number) => '−' + n;", 'h.ts'],
    ['S1', "export const label = (n: number) => 'Total: -' + n;", 'h.ts'],
    ['S3', "const s = (n: number) => (n >= 0 ? '+' : '') + n;", 'h.ts'],
    ['S2', 'export const fmt = (n: number): string => `−${n}`;', 'h.ts'],
    // reviewer round 2: a sign after something earlier on the line used to be skipped
    ['S5', "const a = <b>{t('refund')} −{formatMoney(x)}</b>;"],
    ['S5', "const a = <b>{' '}-{order.total}</b>;"],
    ['S5', 'const a = <b>{/* x */}-{n}</b>;'],
    ['S5', 'const a = <b>{a} - {b}</b>;'],
    ['S6', 'const a = <b>{a} - b</b>;'],
    // marker bypasses: there is no marker any more, so a comment must change nothing
    ['S5', 'const a = <b>{/* sign-ok: */}-{order.total}</b>;'],
    ['S5', 'const a = <b>{/* sign-ok: label */}−{formatMoney(refund)}</b>;'],
    ['S1', "const a = ('sign-ok: x', '-' + n);", 'h.ts'],
    [
      'S1',
      "// sign-ok: helper text here\nexport const f = (n: number) => '-' + formatMoney(n);",
      'h.ts',
    ],
  ];
  it.each(BAD)('flags %s: %s', (rule, code, file) => {
    const hit = signViolations(code, file ?? 'x.tsx').map(v => v.rule);
    expect(hit).toContain(rule);
  });

  it('has no exemption marker anywhere in the tree', () => {
    const marked = DIRS.flatMap(d =>
      walk(join(ROOT, d)).filter(f => /sign-ok/.test(readFileSync(f, 'utf8')))
    );
    expect(marked.map(f => relative(ROOT, f))).toEqual([]);
  });

  const GOOD = [
    'const a = x - 1;',
    'const a = <span className="mt-2 -ml-1">y</span>;',
    "const a = <td>{txn.description || '-'}</td>;",
    'const a = <b><SignedNumber value={v} plus /></b>;',
    'const a = <b>{a}<Sep />{b}</b>;',
    'const v = `hsl(var(--${key}))`;',
    'const a = <b><PlusGlyph /> {t("add")}</b>;',
    'const s = `${a}-${b}`;',
    "const k = 'a' + '-' + 'b';",
    "const id = 'tier2-' + sectionId;",
    "const a = <b>{x ? 'yes' : 'no'}</b>;",
    'const a = <b>{open ? <MinusGlyph /> : <PlusGlyph />}</b>;',
    'const a = <b>Step-{n}</b>;',
  ];
  it.each(GOOD)('allows %s', code => {
    expect(signViolations(code)).toEqual([]);
  });
});
