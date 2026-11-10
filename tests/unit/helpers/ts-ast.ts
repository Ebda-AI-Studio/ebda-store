/**
 * Structural source checks for guard tests. A guard that asserts on the TEXT of a source file
 * (indexOf / slice windows / "a appears before b") can pass on a comment, a dead branch or a
 * neighbouring block. These helpers parse the file with the TypeScript compiler instead, so a
 * test asks about nodes (calls, case clauses, object properties, JSX attributes) and comments
 * and string contents can never satisfy it.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const ROOT = path.resolve(__dirname, '../../..');

export function parseSource(file: string, src = fs.readFileSync(file, 'utf8')): ts.SourceFile {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx?$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
}

export function parseRel(rel: string): ts.SourceFile {
  return parseSource(path.join(ROOT, rel));
}

/** Every node under `root` (inclusive) for which `pred` holds, in source order. */
export function findAll<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[];
export function findAll(root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[];
export function findAll(root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

export const isStr = (n: ts.Node | undefined): n is ts.StringLiteralLike =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

/** `a.b.c(...)` -> "a.b.c"; `fn(...)` -> "fn"; anything else -> "". */
export function calleeText(call: ts.CallExpression | ts.NewExpression): string {
  return call.expression.getText().replace(/\s+/g, '');
}

export function callsTo(root: ts.Node, callee: string): ts.CallExpression[] {
  return findAll(root, (n): n is ts.CallExpression => ts.isCallExpression(n)).filter(
    c => calleeText(c) === callee
  );
}

/** Name of a property / method / function / variable declaration, "" when anonymous. */
export function nameOf(n: ts.Node): string {
  const nm = (n as { name?: ts.Node }).name;
  return nm && (ts.isIdentifier(nm) || isStr(nm)) ? nm.text : '';
}

/** A function-like declaration (function, method, arrow/function expression in a variable) by name. */
export function findFunction(sf: ts.SourceFile, name: string): ts.Node | undefined {
  return findAll(sf, (n): boolean => {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return nameOf(n) === name;
    if (ts.isVariableDeclaration(n))
      return (
        nameOf(n) === name &&
        !!n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      );
    return false;
  })[0];
}

/** Property assignments `key: value` (object literal members) named `key` anywhere under `root`. */
export function props(root: ts.Node, key: string): ts.PropertyAssignment[] {
  return findAll(
    root,
    (n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && nameOf(n) === key
  );
}
