// The flip gate's inventory (INFRA-CF-1 PR D2b-4, Ruling CF-FINAL-1): every code path that refuses a Durable Object store
// (HTTP 501 / `*_NOT_ON_DO`) is found with the TypeScript AST and must be listed in docs/cf/not-on-do.json. The gate to flip a
// store to `do` opens only when BOTH lists in that file are empty. `node scripts/cf/not-on-do.mjs` prints the state and exits
// 1 while the gate is closed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCAN_DIRS = ['apps/api/src', 'packages/repo/src'];
export const MANIFEST = path.join(ROOT, 'docs/cf/not-on-do.json');
const REFUSAL_CODE = /NOT_ON_DO|NOT_PORTED|NOT_SUPPORTED_ON_DO/;
const ERROR_CTORS = new Set(['AppError', 'MoneyError']);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.tsx?$/.test(e.name) &&
      !/\.(test|spec)\.tsx?$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
      ? [p]
      : [];
  });
}

/** Refusals in one source text: `{ code, line }` per `*_NOT_ON_DO` literal and per 501 error (code '501' when it has none). */
export function findRefusals(source, rel = 'x.ts') {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const out = [];
  const at = n => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = n => {
    if (ts.isStringLiteralLike(n) && REFUSAL_CODE.test(n.text) && /^[A-Z0-9_]+$/.test(n.text))
      out.push({ code: n.text, line: at(n) });
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      ERROR_CTORS.has(n.expression.text) &&
      (n.arguments ?? []).some(a => ts.isNumericLiteral(a) && a.text === '501')
    ) {
      const lit = (n.arguments ?? []).find(
        a => ts.isStringLiteralLike(a) && /^[A-Z0-9_]+$/.test(a.text)
      );
      // a 501 whose code is already caught by the literal rule is not listed twice
      if (!(lit && REFUSAL_CODE.test(lit.text)))
        out.push({ code: lit ? lit.text : '501', line: at(n) });
    }
    if (
      ts.isPropertyAssignment(n) &&
      ((ts.isIdentifier(n.name) && n.name.text === 'status') ||
        (ts.isStringLiteral(n.name) && n.name.text === 'status')) &&
      ts.isNumericLiteral(n.initializer) &&
      n.initializer.text === '501'
    )
      out.push({ code: '501', line: at(n) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function scan() {
  const found = [];
  for (const d of SCAN_DIRS)
    for (const f of files(path.join(ROOT, d)))
      for (const r of findRefusals(fs.readFileSync(f, 'utf8'), f))
        found.push({ ...r, file: path.relative(ROOT, f) });
  return found;
}

export function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

/** The gate is open only when no code path refuses and no flow is Postgres-only. */
export function gateState(manifest = readManifest()) {
  const open = manifest.refusals.length === 0 && manifest.postgresOnly.length === 0;
  return { open, refusals: manifest.refusals.length, postgresOnly: manifest.postgresOnly.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = gateState();
  console.log(JSON.stringify(s));
  process.exit(s.open ? 0 : 1);
}
