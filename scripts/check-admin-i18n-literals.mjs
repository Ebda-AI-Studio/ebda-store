#!/usr/bin/env node
/**
 * CI gate: user-visible literal text in `apps/admin` JSX must go through
 * `useT` / next-intl (plan 2026-04-23-admin-i18n-and-extractions-plan, Ruling ADM-I18N-GATE-1).
 *
 * What it flags (AST-based, `.tsx` only, tests and stories excluded):
 *   1. JSX text with a letter in it:              <p>Save changes</p>
 *   2. a string literal rendered as a JSX child:  {'Save'}, {busy ? 'Saving' : 'Save'}, {ok && 'Done'}
 *   3. a literal in a copy-carrying attribute:    placeholder="Search", title, alt, aria-label, label, ...
 *
 * What it never flags (non-copy): attributes that do not carry copy (id, className, data-testid,
 * aria-labelledby / aria-describedby / aria-controls ids, href, name, type, key, ...), JSX text or literals
 * without a letter (digits, punctuation, "/", "·", "×"), and anything inside a `t(...)` call.
 *
 * Escape hatch, for text that is not translatable copy (a brand wordmark, a language's own name, a code
 * sample): `i18n-gate-allow: <reason>` in a comment on the offending line or the contiguous comment block above.
 * The reason is mandatory (a bare marker does not waive).
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SCAN_ROOTS = ['apps/admin/src'];
const ALLOW_MARKER = 'i18n-gate-allow:';

/** Attributes whose string value is shown to the user or read out by a screen reader. */
export const COPY_ATTRS = new Set([
  'placeholder',
  'title',
  'alt',
  'label',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'description',
  'helperText',
  'hint',
  'subtitle',
  'heading',
  'tooltip',
  'caption',
  'emptyText',
  'emptyTitle',
  'emptyMessage',
  'errorMessage',
  'confirmLabel',
  'cancelLabel',
  'submitLabel',
  'loadingText',
  'message',
  'text',
  'summary',
]);

/**
 * A placeholder that shows machine syntax rather than a sentence (URL, e-mail, @handle, /path, #hex, CODE-TOKEN)
 * is a format hint, not copy: it reads the same in every language.
 */
export function isMachineExample(v) {
  return (
    v.includes('://') ||
    /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v) ||
    /^[@#/]/.test(v) ||
    /^[A-Z0-9_-]{2,}$/.test(v)
  );
}

const HAS_LETTER = /[\p{L}]/u;
const skipFile = f =>
  !/\.tsx$/.test(f) ||
  /\.(test|spec|stories)\.tsx$/.test(f) ||
  /(^|\/)(__tests__|__mocks__|node_modules)\//.test(f);

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** String literals a JSX-child expression can render: through ?:, &&, ||, ??, parens. */
function renderedLiterals(expr, out = []) {
  if (ts.isParenthesizedExpression(expr)) return renderedLiterals(expr.expression, out);
  if (ts.isConditionalExpression(expr)) {
    renderedLiterals(expr.whenTrue, out);
    renderedLiterals(expr.whenFalse, out);
    return out;
  }
  if (ts.isBinaryExpression(expr)) {
    const k = expr.operatorToken.kind;
    if (
      k === ts.SyntaxKind.AmpersandAmpersandToken ||
      k === ts.SyntaxKind.BarBarToken ||
      k === ts.SyntaxKind.QuestionQuestionToken
    ) {
      renderedLiterals(expr.right, out);
    }
    return out;
  }
  if (ts.isTemplateExpression(expr)) {
    // `Saved ${n} items`: the static head/spans are copy too.
    const parts = [expr.head.text, ...expr.templateSpans.map(s => s.literal.text)];
    if (parts.some(p => HAS_LETTER.test(p))) out.push(expr);
    return out;
  }
  if (literalText(expr) !== null) out.push(expr);
  return out;
}

function hasWaiver(sourceFile, text, pos) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
  const lines = text.split('\n');
  const waives = l => {
    const i = l.indexOf(ALLOW_MARKER);
    return (
      i >= 0 &&
      l
        .slice(i + ALLOW_MARKER.length)
        .trim()
        .replace(/[*/}\s]+$/, '').length > 0
    );
  };
  if (waives(lines[line] ?? '')) return true;
  for (let i = line - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? '').trim();
    const isComment =
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('{/*') ||
      trimmed.endsWith('*/') ||
      trimmed.endsWith('*/}');
    if (!isComment) return false;
    if (waives(trimmed)) return true;
  }
  return false;
}

/**
 * Same walk as findI18nLiteralViolations but returns the AST too (used by one-off codemods).
 * @returns {{sf: ts.SourceFile, hits: {node: ts.Node, file:string,line:number,column:number,kind:string,snippet:string}[]}}
 */
export function collectI18nLiteralHits(text, fileName = 'input.tsx') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const report = (node, kind, snippet) => {
    const start = node.getStart(sf);
    if (hasWaiver(sf, text, start)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    out.push({
      node,
      file: fileName,
      line: line + 1,
      column: character + 1,
      kind,
      snippet: snippet.replace(/\s+/g, ' ').trim().slice(0, 100),
    });
  };

  const visit = node => {
    if (ts.isJsxText(node)) {
      const t = node.text.replace(/&[a-z]+;|&#\d+;/gi, ' ');
      if (HAS_LETTER.test(t)) report(node, 'text', node.text);
    } else if (ts.isJsxExpression(node) && node.expression) {
      const p = node.parent;
      if (ts.isJsxElement(p) || ts.isJsxFragment(p)) {
        for (const lit of renderedLiterals(node.expression)) {
          const s = literalText(lit);
          const probe = s ?? lit.getText(sf);
          if (HAS_LETTER.test(probe)) report(lit, 'child', lit.getText(sf));
        }
      } else if (ts.isJsxAttribute(p) && COPY_ATTRS.has(p.name.getText(sf))) {
        for (const lit of renderedLiterals(node.expression)) {
          const s = literalText(lit);
          const machine = p.name.getText(sf) === 'placeholder' && s !== null && isMachineExample(s);
          if ((s ?? lit.getText(sf)) && HAS_LETTER.test(s ?? lit.getText(sf)) && !machine) {
            report(lit, `attr ${p.name.getText(sf)}`, lit.getText(sf));
          }
        }
      }
    } else if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      const isMachine =
        node.name.getText(sf) === 'placeholder' && isMachineExample(node.initializer.text);
      if (
        COPY_ATTRS.has(node.name.getText(sf)) &&
        HAS_LETTER.test(node.initializer.text) &&
        !isMachine
      ) {
        report(node.initializer, `attr ${node.name.getText(sf)}`, node.getText(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sf, hits: out };
}

/** @returns {{file:string,line:number,column:number,kind:string,snippet:string}[]} */
export function findI18nLiteralViolations(text, fileName = 'input.tsx') {
  return collectI18nLiteralHits(text, fileName).hits.map(({ node: _node, ...rest }) => rest);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function scanRepo(repoRoot, roots = SCAN_ROOTS) {
  const all = [];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(repoRoot, file);
      if (skipFile(rel)) continue;
      all.push(...findI18nLiteralViolations(fs.readFileSync(file, 'utf8'), rel));
    }
  }
  return all;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const v = scanRepo(repoRoot);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(v, null, 1));
    process.exit(v.length ? 1 : 0);
  }
  if (v.length === 0) {
    console.log(`✓ admin i18n literal gate: no hardcoded copy in JSX (${SCAN_ROOTS.join(', ')})`);
    process.exit(0);
  }
  console.error(
    `\n✗ admin i18n literal gate: ${v.length} hardcoded user-visible string(s) in apps/admin JSX.\n` +
      `  Wrap with useT (next-intl) and add the key to BOTH apps/admin/src/i18n/messages/en.json and ar.json,\n` +
      `  or waive non-copy text with \`${ALLOW_MARKER} <reason>\` on the line or the comment above.\n`
  );
  for (const x of v) console.error(`  ${x.file}:${x.line}:${x.column}  [${x.kind}] ${x.snippet}`);
  console.error('');
  process.exit(1);
}
