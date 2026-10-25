// D1 access through `wrangler d1 execute` (works for --local with a persisted state dir and for --remote).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

/** @param {{db:string, target:'local'|'remote', config?:string, persistTo?:string}} d */
function base(d) {
  const a = ['wrangler', 'd1', 'execute', d.db, d.target === 'remote' ? '--remote' : '--local'];
  if (d.config) a.push('-c', d.config);
  if (d.persistTo && d.target !== 'remote') a.push('--persist-to', d.persistTo);
  return a;
}

export async function d1Query(d, sql) {
  const { stdout } = await run('npx', [...base(d), '--json', '--command', sql], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const j = JSON.parse(stdout.slice(stdout.indexOf('[')));
  const bad = j.find(x => x.success === false);
  if (bad) throw new Error(`D1 query failed: ${JSON.stringify(bad).slice(0, 400)}`);
  return j.at(-1).results ?? [];
}

export async function d1File(d, file) {
  await run('npx', [...base(d), '--yes', '--file', file], { maxBuffer: 512 * 1024 * 1024 });
}

export const lit = v =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
