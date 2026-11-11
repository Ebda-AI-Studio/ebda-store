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
 *   S7  <MinusGlyph/> followed by any value, or <PlusGlyph/> followed by a number-shaped value or <SignedNumber>
 *       (the glyphs are aria-hidden: a screen reader would read a refund as positive)
 * Also signs: MINUS / PLUS constants, HTML entities (&minus; &plus; &#8722; &#x2212;), fullwidth/small signs, `${'-'}`.
 * Residual (ruling SIGN-GUARD-1): join()/concat() and exotic sign characters. Lint aid; review + render tests are the gate.
 * Use <SignedNumber> (JSX) or formatSigned() (a string that cannot be markup).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '../..');
const DIRS = ['apps/admin/src', 'apps/web/src', 'apps/orders/src', 'packages/ui/src'];
// ASCII, U+2212 minus, fullwidth (U+FF0B/FF0D) and small (U+FE62/FE63) forms.
const SIGNS = '+-\u2212\uFF0B\uFF0D\uFE62\uFE63';

/** A value that is a number or builds one: the glued-word carve-out never applies in front of it. */
const NUMBERISH =
  /amount|total|price|count|delta|points|money|format|fmt|fee|balance|qty|quantity|refund|discount|cost|sum|minor|piastre|fils|percent|pct|major/i;
/** A word that labels a number ("EGP-", "total-"): a sign after it is a sign, not a hyphen. */
const LABEL_WORD =
  /^(egp|usd|sar|kwd|aed|eur|gbp|total|subtotal|refund|refunded|discount|amount|price|balance|net|fee|tax|credit|debit|points|ج\.م|جنيه|ر\.س)$/i;

/** JSX text with the sign entities decoded (`&minus;`, `&#8722;`, `&#x2212;`, `&plus;`, `&#43;`). */
export function decodeSignEntities(text: string): string {
  return text
    .replace(/&(?:minus|#8722|#x2212|#0*8722|hyphen|#45|#x2d|dash);/gi, '\u2212')
    .replace(/&(?:plus|#43|#x2b);/gi, '+');
}

/**
 * Text ends in a sign. A hyphen glued to a word ("tier2-") is not a sign, unless the word labels a number
 * ("EGP-", "total-") or a number-shaped value follows (`numberNext`).
 */
export function endsWithSign(text: string, numberNext = false): boolean {
  const t = decodeSignEntities(text).trimEnd();
  if (!t || !SIGNS.includes(t[t.length - 1]!)) return false;
  const before = t.slice(0, -1);
  if (before === '') return true;
  const word = /[\p{L}\p{N}.\u0600-\u06FF]+$/u.exec(before)?.[0];
  if (word === undefined) return !before.endsWith(t[t.length - 1]!); // `--x` custom property
  if (/\s$/.test(before)) return true;
  // a label word that is itself part of a hyphenated id (`variant-price-`) is an id
  const inId = /[-_/:]$/.test(before.slice(0, before.length - word.length));
  return numberNext || (LABEL_WORD.test(word) && !inId);
}
/** Text starts with a sign that is not glued to a word. */
export function startsWithSign(text: string): boolean {
  const t = decodeSignEntities(text).trimStart();
  if (!t || !SIGNS.includes(t[0]!)) return false;
  const after = t.slice(1);
  return after === '' || /^[\s\d]/.test(after);
}

const lit = (n: ts.Node): string | null =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
const unwrap = (n: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;
/** A sign literal, or the shared sign constants MINUS / PLUS. */
const isSignLit = (n: ts.Node): boolean => {
  const u = unwrap(n);
  if (ts.isIdentifier(u)) return u.text === 'MINUS' || u.text === 'PLUS';
  const t = lit(u);
  return t !== null && t.length === 1 && SIGNS.includes(t);
};
const isEmptyLit = (n: ts.Node): boolean => lit(unwrap(n)) === '';
const isPlainLiteral = (n: ts.Node): boolean => lit(n) !== null || ts.isNumericLiteral(n);
/** A numeric literal, or an expression whose text names an amount / count / format call. */
const isNumberShaped = (n: ts.Node, sf: ts.SourceFile): boolean =>
  ts.isNumericLiteral(n) || (!isPlainLiteral(n) && NUMBERISH.test(n.getText(sf)));
const isDynamicChild = (n: ts.Node | undefined): boolean =>
  !!n && (ts.isJsxExpression(n) || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n));
/** `{' '}` or an empty JSX comment: transparent when looking for the value that follows a sign. */
const isSpacer = (n: ts.Node): boolean =>
  ts.isJsxExpression(n) &&
  (!n.expression || (lit(n.expression) !== null && lit(n.expression)!.trim() === ''));
const glyphName = (n: ts.Node): string | null =>
  ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null;

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
      if (isSignLit(l) && !isPlainLiteral(r)) add(n, 'S1');
      else if (lt !== null && endsWithSign(lt, isNumberShaped(r, sf)) && !isPlainLiteral(r))
        add(n, 'S1');
      else if (rt !== null && startsWithSign(rt) && !isPlainLiteral(l)) add(n, 'S1');
    }
    if (ts.isTemplateExpression(n)) {
      const first = n.templateSpans[0];
      if (
        endsWithSign(n.head.text, !!first && isNumberShaped(first.expression, sf)) ||
        n.templateSpans.some(sp => isSignLit(sp.expression))
      )
        add(n, 'S2');
    }
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
        const after = kids
          .slice(i + 1)
          .find(c => !isSpacer(c) && !(ts.isJsxText(c) && c.text.trim() === ''));
        if (
          ts.isJsxExpression(k) &&
          k.expression &&
          isSignLit(k.expression) &&
          isDynamicChild(next)
        )
          add(k, 'S4');
        if (ts.isJsxExpression(k) && k.expression) {
          const t = lit(unwrap(k.expression));
          if (t !== null && !isSignLit(k.expression) && endsWithSign(t) && isDynamicChild(next))
            add(k, 'S4');
        }
        if (ts.isJsxText(k)) {
          const nextNumber =
            !!next &&
            ts.isJsxExpression(next) &&
            !!next.expression &&
            isNumberShaped(next.expression, sf);
          if (endsWithSign(k.text, nextNumber) && isDynamicChild(next)) add(k, 'S5');
          else if (startsWithSign(k.text) && isDynamicChild(prev)) add(k, 'S6');
        }
        // S7: the glyph components are not signs for a value. MinusGlyph: nothing after it; PlusGlyph: only a label.
        const g = glyphName(k);
        if (g === 'MinusGlyph' && after && isDynamicChild(after)) add(k, 'S7');
        if (
          g === 'PlusGlyph' &&
          after &&
          ts.isJsxExpression(after) &&
          after.expression &&
          isNumberShaped(after.expression, sf)
        )
          add(k, 'S7');
        if (
          (g === 'PlusGlyph' || g === 'MinusGlyph') &&
          after &&
          ts.isJsxSelfClosingElement(after) &&
          glyphName(after) === 'SignedNumber'
        )
          add(k, 'S7');
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
    // final round: constants, glyph components, entities, template spans, glued words, wide signs
    [
      'S1',
      "import { MINUS } from '@ebda/shared';\nexport const f = (n: number) => MINUS + formatMoney(n);",
      'h.ts',
    ],
    ['S1', 'export const f = (n: number) => PLUS + n;', 'h.ts'],
    ['S4', 'const a = <b>{MINUS}{formatMoney(x)}</b>;'],
    ['S4', 'const a = <b>{PLUS}{n}</b>;'],
    ['S3', "const a = <b>{x > 0 ? PLUS : ''}{n}</b>;"],
    ['S7', 'const a = <b><MinusGlyph />{formatMoney(refund)}</b>;'],
    ['S7', "const a = <b><MinusGlyph />{' '}{n}</b>;"],
    ['S7', 'const a = <b><PlusGlyph />{formatMoney(x)}</b>;'],
    ['S7', 'const a = <b><PlusGlyph /><SignedNumber value={v} /></b>;'],
    ['S5', 'const a = <b>&minus;{formatMoney(x)}</b>;'],
    ['S5', 'const a = <b>&#8722;{formatMoney(x)}</b>;'],
    ['S5', 'const a = <b>&#x2212;{formatMoney(x)}</b>;'],
    ['S5', 'const a = <b>&plus;{count}</b>;'],
    ['S2', "export const f = (n: number) => `${'-'}${n}`;", 'h.ts'],
    ['S2', 'export const f = (n: number) => `${MINUS}${n}`;', 'h.ts'],
    ['S1', "export const f = (n: number) => 'EGP-' + formatMoney(n);", 'h.ts'],
    ['S1', "export const f = (n: number) => 'total-' + n;", 'h.ts'],
    ['S1', "export const f = (v: number) => 'tier2-' + amount(v);", 'h.ts'],
    ['S5', 'const a = <b>total-{n}</b>;'],
    ['S5', 'const a = <b>ج.م-{n}</b>;'],
    ['S1', "export const f = (n: number) => '\uFF0D' + n;", 'h.ts'],
    ['S1', "export const f = (n: number) => '\uFE63' + n;", 'h.ts'],
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
    'const a = <b><MinusGlyph /></b>;',
    "const a = <b><PlusGlyph /> {t('add')}</b>;",
    'const a = <b><PlusGlyph /> {label}</b>;',
    "export const id = (sectionId: string) => 'tier2-' + sectionId;",
    'export const id = (r: Row) => `variant-price-${r.rowId}`;',
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
