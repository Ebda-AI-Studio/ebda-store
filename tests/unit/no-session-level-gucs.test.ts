/**
 * Session-level GUCs are banned (R-EBDA-001, docs/ebda/design/cloudflare-backend.md §3).
 *
 * The tenant settings RLS reads (`app.current_store_id`, `app.current_user_id`)
 * must be TRANSACTION-LOCAL: `set_config(name, value, true)` or `SET LOCAL`.
 * Behind a transaction-mode pooler (Hyperdrive, pgbouncer, Neon) a server
 * connection is handed to a different tenant after every COMMIT, so a
 * session-level setting persists on it and the NEXT tenant inherits the previous
 * tenant's store. The spike's negative control (`set_config(..., false)` through
 * pgbouncer) leaked into a later, different client 13-20 times out of 20.
 *
 * This is a source scan: it fails on any session-level setting in the runtime
 * code (apps/*\/src, packages/*\/src, scripts). It is paired with the pooler
 * integration test (tests/integration/rls-pooler-isolation.test.ts), which
 * proves the same property at runtime.
 *
 * Mutation record: see the commit that added this file. Adding
 * `await tx.$executeRaw\`SET app.current_store_id = 'x'\`` or flipping one
 * `set_config(..., true)` to `false` in apps/api/src turns this test red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.open-next',
  'generated',
  '__tests__',
  '.wrangler',
]);

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js|cjs|sql|sh)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      out.push(p);
    }
  }
}

/** Source roots that ship or run against a production database. */
export function sourceFiles(): string[] {
  const roots: string[] = [path.join(ROOT, 'scripts')];
  for (const group of ['apps', 'packages']) {
    const g = path.join(ROOT, group);
    if (!fs.existsSync(g)) continue;
    for (const pkg of fs.readdirSync(g)) roots.push(path.join(g, pkg, 'src'));
  }
  const files: string[] = [];
  for (const r of roots) walk(r, files);
  return files;
}

/** Strip // and block comments (a comment may legitimately SAY "SET app.x"). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

// `SET <dotted.guc> = ...` / `SET <dotted.guc> TO ...` without LOCAL, `SET SESSION ...`,
// `SET ROLE x` / `SET SESSION AUTHORIZATION`, and the well-known per-session knobs.
// `UPDATE t SET col = ...` is NOT matched: column names are not dotted and not in the list.
const SESSION_SET_RES: RegExp[] = [
  /\bSET\s+SESSION\b/i,
  /\bSET\s+(?!LOCAL\b)[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_.]*\s*(=|\bTO\b)/i,
  /\bSET\s+(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|search_path|work_mem|row_security|timezone|time\s+zone)\b/i,
  /\bSET\s+ROLE\s+[^\s=]/i,
];

/** Findings (line, text) of session-level settings in already comment-stripped source. */
export function findSessionLevelGucs(src: string): Array<{ line: number; text: string }> {
  const findings: Array<{ line: number; text: string }> = [];
  const lines = src.split('\n');
  lines.forEach((text, i) => {
    if (SESSION_SET_RES.some(re => re.test(text)))
      findings.push({ line: i + 1, text: text.trim() });
  });

  // set_config(name, value, is_local): the third argument must be the literal `true`.
  const re = /set_config\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = re.lastIndex;
    const args: string[] = [];
    let cur = '';
    for (; j < src.length && depth > 0; j++) {
      const ch = src[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
      if (ch === ',' && depth === 1) {
        args.push(cur);
        cur = '';
      } else cur += ch;
    }
    args.push(cur);
    const third = (args[2] ?? '').trim();
    if (args.length !== 3 || third !== 'true') {
      const line = src.slice(0, m.index).split('\n').length;
      findings.push({ line, text: `set_config(${args.map(a => a.trim()).join(', ')})` });
    }
  }
  return findings;
}

describe('no session-level GUCs (transaction-mode pooler safety)', () => {
  it('the detector flags session-level settings and accepts transaction-local ones', () => {
    const bad = [
      "await tx.$executeRaw`SET app.current_store_id = 'x'`;",
      "await tx.$executeRawUnsafe(`SET SESSION app.current_user_id = '${id}'`);",
      "SELECT set_config('app.current_store_id', $1, false)",
      "SELECT set_config('app.current_store_id', $1, is_local)",
      "SELECT set_config('app.current_store_id', $1)",
      'SET statement_timeout = 5000',
      'SET ROLE ebda_app',
      "SET app.current_store_id TO 'x'",
    ];
    for (const b of bad) {
      expect(findSessionLevelGucs(b), b).not.toHaveLength(0);
    }
    const good = [
      "await tx.$executeRaw`SET LOCAL app.current_store_id = 'x'`;",
      "SELECT set_config('app.current_store_id', $1, true)",
      "SELECT set_config('statement_timeout', ${String(MS)}, true)",
      "SELECT set_config('app.current_store_id', $1, true), set_config('app.current_user_id', $2, true)",
      "UPDATE users SET role = 'staff', status = 'active' WHERE id = $1",
      'UPDATE t SET statement = 1',
      '// SET app.x = 1 in a comment',
    ];
    for (const g of good) {
      expect(findSessionLevelGucs(stripComments(g)), g).toHaveLength(0);
    }
  });

  it('scans a non-trivial set of source files', () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it('no runtime source sets a GUC at session level', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      for (const hit of findSessionLevelGucs(stripComments(fs.readFileSync(f, 'utf8')))) {
        offenders.push(`${path.relative(ROOT, f)}:${hit.line}  ${hit.text}`);
      }
    }
    expect(offenders, `session-level GUC(s):\n${offenders.join('\n')}`).toEqual([]);
  });
});
