/**
 * Source-scan helpers shared by the guard tests (no-session-level-gucs, no-rls-bypass-in-runtime).
 * Scans the runtime source roots: apps/*\/src, packages/*\/src and scripts, minus tests/build output.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

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
