#!/usr/bin/env node
/**
 * CI gate — an UPDATE payload may never send `X || undefined`.
 *
 * The defect class this closes: an admin form that maps an emptied input to
 * `undefined` inside the body of an `apiPut` / `apiPatch` produces a payload
 * whose key `JSON.stringify` DROPS. Every write path in this repo (Prisma's
 * nullable-column convention, `StoreService.update`'s shallow `settings`
 * merge, the service-layer present-only spreads) treats an absent key as
 * "leave the stored value alone" — so the save succeeds, `updatedAt` moves,
 * and the merchant's clear is silently discarded. The convention is:
 *
 *     null      → clear the stored value
 *     undefined → key omitted → leave the stored value
 *
 * Shipped instances of the bug: an emptied product description, a coupon's
 * minimum-order restriction, and — worst — a store's `orderInvoiceEmail`,
 * where a merchant who removed the address kept having every order's invoice
 * emailed to it.
 *
 * A rule that lives only in CLAUDE.md is a preference, not a gate. This is
 * the gate. Use `textFieldValue` / `numericFieldValue` / `dateFieldValue`
 * from `apps/admin/src/lib/form-text.ts` instead.
 *
 * DELIBERATELY NARROW so it stays enabled:
 *   - only `apiPut` / `apiPatch` (update). `apiPost` create paths are correct
 *     with `undefined` — there is nothing to clear on a create.
 *   - only inside an object literal in the call's arguments, at any depth.
 *   - anything that is not an update payload (React props, local config
 *     objects that get whole-object-replaced server-side such as the page
 *     builder's `layout` sections or the floating widget config) is untouched.
 *
 * Escape hatch, for an endpoint that genuinely has no null form: put
 * `clear-gate-allow: <reason>` in a comment on the offending line or the line
 * directly above it. A waiver must state why the field cannot be cleared.
 */

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const UPDATE_CALLS = new Set(['apiPut', 'apiPatch']);
const ALLOW_MARKER = 'clear-gate-allow';

/** Scanned roots, relative to the repo root. */
export const SCAN_ROOTS = ['apps/admin/src', 'apps/orders/src', 'apps/web/src'];

function calleeName(node) {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function isOrUndefined(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    ts.isIdentifier(node.right) &&
    node.right.text === 'undefined'
  );
}

/**
 * True when `node` is (or is nested inside) the value of an object-literal
 * property — i.e. it really is a payload KEY and not, say, an argument or a
 * JSX attribute.
 */
function isObjectPropertyValue(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) return true;
    // Stop climbing at anything that is no longer a value expression.
    if (
      ts.isCallExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isReturnStatement(parent)
    ) {
      return false;
    }
    current = parent;
  }
  return false;
}

/**
 * A waiver is the marker on the offending line itself, or anywhere in the
 * contiguous comment block directly above it — so a multi-line explanation
 * counts, and a comment attached to some unrelated earlier statement does not.
 */
function hasWaiver(sourceFile, text, pos) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
  const lines = text.split('\n');
  if ((lines[line] ?? '').includes(ALLOW_MARKER)) return true;
  for (let i = line - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? '').trim();
    const isComment =
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.endsWith('*/');
    if (!isComment) return false;
    if (trimmed.includes(ALLOW_MARKER)) return true;
  }
  return false;
}

/**
 * @returns {{file: string, line: number, column: number, call: string, snippet: string}[]}
 */
export function findClearGateViolations(text, fileName = 'input.tsx') {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const violations = [];

  const scanArgument = (node, call) => {
    if (isOrUndefined(node) && isObjectPropertyValue(node)) {
      if (!hasWaiver(sourceFile, text, node.getStart(sourceFile))) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        );
        violations.push({
          file: fileName,
          line: line + 1,
          column: character + 1,
          call,
          snippet: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, child => scanArgument(child, call));
  };

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && UPDATE_CALLS.has(name)) {
        for (const arg of node.arguments) scanArgument(arg, name);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) yield full;
  }
}

export function scanRepo(repoRoot, roots = SCAN_ROOTS) {
  const all = [];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(repoRoot, file);
      all.push(...findClearGateViolations(fs.readFileSync(file, 'utf8'), rel));
    }
  }
  return all;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const violations = scanRepo(repoRoot);

  if (violations.length === 0) {
    console.log(
      `✓ clear-on-empty gate: no \`|| undefined\` in an apiPut/apiPatch payload (${SCAN_ROOTS.join(', ')})`
    );
    process.exit(0);
  }

  console.error(
    `\n✗ clear-on-empty gate: ${violations.length} update payload(s) send \`|| undefined\`.\n` +
      `  An omitted key means "leave the stored value alone", so the merchant can never clear the field.\n` +
      `  Use textFieldValue / numericFieldValue / dateFieldValue from apps/admin/src/lib/form-text.ts\n` +
      `  with intent 'update' (they send null), or waive with a \`${ALLOW_MARKER}: <reason>\` comment.\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.column}  ${v.call}(…) → ${v.snippet}`);
  }
  console.error('');
  process.exit(1);
}
