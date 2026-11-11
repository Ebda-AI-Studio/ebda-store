/**
 * SIGN-1 guard (ebda-foundation design/DESIGN.md; formatter: packages/shared/src/region/signed.ts).
 *
 * AST-based (TypeScript compiler API) over every .ts/.tsx under apps/{admin,web,orders} + packages/ui.
 * Fails on a sign BUILT BY HAND in front of a value:
 *   S1  string sign literal concatenated with a non-literal: `'-' + formatMoney(x)`, `'+' + count`, `'−' + n`
 *   S2  template whose head is a bare sign: `-${n}`, `+${n}`, `−${fmt(x)}`
 *   S3  conditional that picks a sign literal against '' or another sign: `x > 0 ? '+' : ''`, `a ? '−' : '+'`
 *   S4  JSX child sign literal next to an expression: `{'−'}{x}`
 *   S5  JSX text that ends in a sign and is followed by an expression: `-{n}`, `+{n}`, `- {n}`, `−{n}`
 *       (a separator between two expressions, `{a} - {b}`, is not flagged)
 * Use <SignedNumber> (JSX) or formatSigned() (a string that cannot be markup). Escape hatch for a line that is not
 * a number (keyboard key, disclosure glyph): `sign-ok: <reason>` in a comment on that line or the line above.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '../..');
const DIRS = ['apps/admin/src', 'apps/web/src', 'apps/orders/src', 'packages/ui/src'];
const SIGNS = new Set(['+', '-', '−']);

const isSignLit = (n: ts.Node | undefined): boolean =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && SIGNS.has(n.text);
const isEmptyLit = (n: ts.Node): boolean =>
  (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === '';
const isLiteral = (n: ts.Node): boolean =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n);
const unwrap = (n: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;

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
    if (/sign-ok:/.test(lines[line] ?? '') || /sign-ok:/.test(lines[line - 1] ?? '')) return;
    out.push({ line: line + 1, rule, text: (lines[line] ?? '').trim() });
  };

  const visit = (n: ts.Node) => {
    // S1: '-' + expr / expr + '-'(no: a trailing sign is a suffix) -> only a LEADING sign literal
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = unwrap(n.left);
      const r = unwrap(n.right);
      if (isSignLit(l) && !isLiteral(r)) add(n, 'S1');
    }
    // S2: `-${x}`
    if (ts.isTemplateExpression(n) && SIGNS.has(n.head.text)) add(n, 'S2');
    // S3: cond ? '+' : '' / cond ? '−' : '+'
    if (ts.isConditionalExpression(n)) {
      const a = unwrap(n.whenTrue);
      const b = unwrap(n.whenFalse);
      if ((isSignLit(a) && (isEmptyLit(b) || isSignLit(b))) || (isSignLit(b) && isEmptyLit(a)))
        add(n, 'S3');
    }
    // S4 + S5: JSX children
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      const kids = n.children;
      kids.forEach((k, i) => {
        const next = kids[i + 1];
        const prev = kids[i - 1];
        const nextIsExpr =
          !!next &&
          (ts.isJsxExpression(next) || ts.isJsxElement(next) || ts.isJsxSelfClosingElement(next));
        if (
          ts.isJsxExpression(k) &&
          k.expression &&
          isSignLit(unwrap(k.expression)) &&
          nextIsExpr
        ) {
          add(k, 'S4');
        }
        if (ts.isJsxText(k) && nextIsExpr) {
          const t = k.text;
          const m = /([+−-])\s*$/.exec(t);
          if (m) {
            const before = t.slice(0, m.index);
            const startsLine = before.trim() === '';
            const afterExpr = !!prev && !ts.isJsxText(prev);
            // `{a} - {b}`: a sign between two expressions on the same line is a separator
            if (startsLine && (!afterExpr || /\n/.test(before))) add(k, 'S5');
          }
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
  const BAD: Array<[string, string]> = [
    ['S2', 'const a = <b>{row.delta >= 0 ? `+${row.delta}` : row.delta}</b>;'],
    ['S3', "const a = <b>{entry.amount > 0 ? '+' : '−'}</b>;"],
    ['S5', 'const a = <span>-{member.totalRedeemed}</span>;'],
    ['S5', 'const a = <dd>−{formatMoney(x)}</dd>;'],
    ['S3', "const a = <dd>{l.adjustment > 0 ? '-' : l.adjustment < 0 ? '+' : ''}</dd>;"],
    ['S2', 'function f() { return `-${pct.toFixed(1)}%`; }'],
    ['S4', "const a = <b>{'−'}{x}</b>;"],
    ['S5', 'const a = <b>- {n}</b>;'],
    ['S5', 'const a = <b>\n  + {n}\n</b>;'],
    ['S1', "const a = <b>{'+' + count}</b>;"],
    ['S1', "function f(x: number) { return '-' + formatMoney(x); }"],
    ['S1', "export const label = (n: number) => '−' + n;"],
    ['S3', "const s = (n: number) => (n >= 0 ? '+' : '') + n;"],
    ['S2', 'export const fmt = (n: number): string => `−${n}`;'],
  ];
  it.each(BAD)('flags %s: %s', (rule, code) => {
    const hit = signViolations(code, code.includes('<') ? 'x.tsx' : 'x.ts').map(v => v.rule);
    expect(hit).toContain(rule);
  });
  it('flags the .ts helper shape in a .ts file', () => {
    expect(signViolations("export const f = (x: number) => '-' + fmt(x);", 'h.ts')).not.toEqual([]);
  });

  const GOOD = [
    'const a = x - 1;',
    'const a = <span className="mt-2 -ml-1">y</span>;',
    "const a = <td>{txn.description || '-'}</td>;",
    'const a = <b>{a} - {b}</b>;',
    'const a = <b><SignedNumber value={v} plus /></b>;',
    'const s = `${a}-${b}`;',
    "const k = 'a' + '-' + 'b';",
    "const f = (n: number) => n + '-';",
    "const a = <b>{x ? 'yes' : 'no'}</b>;",
    "const a = <b>{isOpen ? '−' : '+'} {/* sign-ok: disclosure */}</b>;",
  ];
  it.each(GOOD)('allows %s', code => {
    expect(signViolations(code)).toEqual([]);
  });
});
