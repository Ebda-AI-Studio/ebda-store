/**
 * Structural (AST) helpers for guard tests that pin a property of production source. Unlike
 * `indexOf`/`slice` on raw text they cannot be satisfied by a comment or a string holding the
 * needle, and a "region" is a real syntax node, never a character window that can catch a
 * neighbour.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = path.resolve(__dirname, '../../..');

export function parseFile(rel: string): ts.SourceFile {
  const abs = path.join(REPO_ROOT, rel);
  const kind = /\.tsx$/.test(rel)
    ? ts.ScriptKind.TSX
    : /\.m?js$/.test(rel)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

/** Pre-order (= source order) visit of every descendant of `root`. */
export function visit(root: ts.Node, cb: (n: ts.Node) => void): void {
  const go = (n: ts.Node) => {
    cb(n);
    ts.forEachChild(n, go);
  };
  ts.forEachChild(root, go);
}

export function all<T extends ts.Node>(root: ts.Node, guard: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  visit(root, n => {
    if (guard(n)) out.push(n);
  });
  return out;
}

const nameOf = (n: ts.Node & { name?: ts.Node }): string | undefined =>
  n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : undefined;

/** A function, method, or `const x = (...) => ...` / `x = createFn(...)` declaration called `name`. */
export function declNamed(root: ts.Node, name: string): ts.Node {
  let found: ts.Node | undefined;
  visit(root, n => {
    if (found) return;
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isVariableDeclaration(n)) &&
      nameOf(n) === name
    )
      found = n;
  });
  if (!found) throw new Error(`declaration not found: ${name}`);
  return found;
}

/** Callee text of a call, whitespace-free (`step.sendEvent`, `tx.user.create`, `guard`). */
export const calleeText = (c: ts.CallExpression): string =>
  c.expression.getText().replace(/\s+/g, '');

/** Every call under `root` in source order, optionally only those whose callee text matches. */
export function callsIn(root: ts.Node, callee?: string | RegExp): ts.CallExpression[] {
  return all(root, ts.isCallExpression).filter(c => {
    if (callee === undefined) return true;
    const t = calleeText(c);
    return typeof callee === 'string' ? t === callee : callee.test(t);
  });
}

export const startOf = (n: ts.Node): number => n.getStart();

/** The string value of a string/no-substitution-template literal, else undefined. */
export const strVal = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;

/** Property of an object literal by name (assignment or shorthand). */
export function prop(
  obj: ts.ObjectLiteralExpression,
  name: string
): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(p => nameOf(p as never) === name);
}

export function hasAncestor(n: ts.Node, pred: (a: ts.Node) => boolean): boolean {
  for (let p = n.parent; p; p = p.parent) if (pred(p)) return true;
  return false;
}
