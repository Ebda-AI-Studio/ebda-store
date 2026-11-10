/**
 * Structural (AST) helpers for tests that must read a production SOURCE file because the code cannot be run
 * under a fake (a 3000-line React component with no DOM in this repo, the API entrypoint that boots a server,
 * a Next page, an Inngest handler that needs a whole Gemini rig).
 *
 * They replace `src.indexOf(...)` / `src.slice(i, i + 300)` windows: a window can pass while the behaviour is
 * wrong (the text sits in a comment, in another branch, or the window catches a neighbour). Here every check is
 * scoped to a real syntax node (a named function, a case clause, an object literal, a JSX element), comments are
 * not code, and "A happens before B" is "statement A precedes statement B in the SAME block".
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';

export function parseFile(file: string): ts.SourceFile {
  return parseText(readFileSync(file, 'utf8'), file);
}

export function parseText(text: string, fileName = 'snippet.tsx'): ts.SourceFile {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

/** Every node under `root` (root included), pre-order. `skipFunctions` does not descend into nested functions. */
export function nodesOf(root: ts.Node, skipFunctions = false): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node, isRoot: boolean) => {
    out.push(n);
    if (skipFunctions && !isRoot && ts.isFunctionLike(n)) return;
    ts.forEachChild(n, c => visit(c, false));
  };
  visit(root, true);
  return out;
}

/** The source text of a node with its comments removed and whitespace normalised. */
export function code(node: ts.Node): string {
  const sf = node.getSourceFile();
  const printed = ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, sf);
  return printed.replace(/\s+/g, ' ').trim();
}

/** `const name = <fn>` or `const name = useCallback(<fn>, deps)` or `function name() {}` -> the function node. */
export function findFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  for (const n of nodesOf(sf)) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) return n;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      let init = n.initializer;
      if (init && ts.isCallExpression(init) && init.arguments.length > 0) init = init.arguments[0];
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
    }
  }
  throw new Error(`function ${name} not found in ${sf.fileName}`);
}

/** The statements of a function body (an expression-bodied arrow has none). */
export function statementsOf(fn: ts.FunctionLikeDeclaration): readonly ts.Statement[] {
  return fn.body && ts.isBlock(fn.body) ? fn.body.statements : [];
}

/** Every call under `root` whose callee prints as `callee` (e.g. `setStep`, `api.createOrder`). */
export function callsTo(root: ts.Node, callee: string, skipFunctions = false): ts.CallExpression[] {
  return nodesOf(root, skipFunctions).filter(
    (n): n is ts.CallExpression => ts.isCallExpression(n) && code(n.expression) === callee
  );
}

/** True when `statement` is, or contains, a call to `callee`. */
export function containsCall(statement: ts.Node, callee: string, arg0?: string): boolean {
  return callsTo(statement, callee).some(
    c => arg0 === undefined || (c.arguments[0] && code(c.arguments[0]) === arg0)
  );
}

/** Index of the first top-level statement of `statements` satisfying `pred` (-1 when none). */
export function indexOfStatement(
  statements: readonly ts.Statement[],
  pred: (s: ts.Statement) => boolean
): number {
  return statements.findIndex(pred);
}

/** `if (<cond>) ...` statements whose condition prints as `cond`. */
export function isIfWithCondition(s: ts.Node, cond: string): s is ts.IfStatement {
  return ts.isIfStatement(s) && code(s.expression) === cond;
}

/** The statements of an if's then-branch (a block's statements, or the single statement). */
export function thenStatements(s: ts.IfStatement): readonly ts.Statement[] {
  return ts.isBlock(s.thenStatement) ? s.thenStatement.statements : [s.thenStatement];
}

export function hasTopLevelReturn(statements: readonly ts.Statement[]): boolean {
  return statements.some(s => ts.isReturnStatement(s));
}

/** The `case '<label>':` clause of a switch (searched anywhere under `root`). */
export function findCaseClause(root: ts.Node, label: string): ts.CaseClause {
  for (const n of nodesOf(root)) {
    if (ts.isCaseClause(n) && ts.isStringLiteralLike(n.expression) && n.expression.text === label)
      return n;
  }
  throw new Error(`case '${label}' not found`);
}

/** The text of a (template) string literal with `${...}` substitutions replaced by `sub`. */
export function stringText(node: ts.Node, sub = ' '): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map(s => sub + s.literal.text).join('');
  return null;
}

/** Comment text (// and /* *\/) attached in front of a node. */
export function leadingComments(node: ts.Node): string {
  const text = node.getSourceFile().text;
  return (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
    .map(r => text.slice(r.pos, r.end))
    .join('\n');
}

/** The call expression that encloses the object literal property `key: 'value'` (e.g. `inngest.createFunction({ id: 'x' }, ...)`). */
export function callEnclosingProperty(
  sf: ts.SourceFile,
  key: string,
  value: string
): ts.CallExpression {
  for (const n of nodesOf(sf)) {
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === key &&
      ts.isStringLiteralLike(n.initializer) &&
      n.initializer.text === value
    ) {
      let p: ts.Node | undefined = n.parent;
      while (p && !ts.isCallExpression(p)) p = p.parent;
      if (p) return p;
    }
  }
  throw new Error(`no call with { ${key}: '${value}' } in ${sf.fileName}`);
}

/** The innermost named function (declaration or `const x = () =>`) that contains `node`. */
export function enclosingFunctionName(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent) &&
      ts.isIdentifier(p.parent.name)
    )
      return p.parent.name.text;
  }
  return null;
}
