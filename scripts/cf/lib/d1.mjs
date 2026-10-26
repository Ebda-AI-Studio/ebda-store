// D1 access through `wrangler d1 execute` (works for --local with a persisted state dir and for --remote).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/** several statements in ONE wrangler call (a call costs ~1 s); returns one result array per statement */
export async function d1QueryMany(d, statements) {
  const { stdout } = await run('npx', [...base(d), '--json', '--command', statements.join(';\n')], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const j = JSON.parse(stdout.slice(stdout.indexOf('[')));
  const bad = j.find(x => x.success === false);
  if (bad) throw new Error(`D1 query failed: ${JSON.stringify(bad).slice(0, 400)}`);
  if (j.length !== statements.length)
    throw new Error(`D1 returned ${j.length} result sets for ${statements.length} statements`);
  return j.map(x => x.results ?? []);
}

export async function d1File(d, file) {
  await run('npx', [...base(d), '--yes', '--file', file], { maxBuffer: 512 * 1024 * 1024 });
}

export const lit = v =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

/**
 * Run SQL statements through `wrangler d1 execute --file` without a predictable temp path: a private
 * mkdtemp directory (0700), the file created exclusively (`wx`) with mode 0600, removed in `finally`.
 */
export async function d1Statements(d, statements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebda-d1-'));
  const file = path.join(dir, 'statements.sql');
  try {
    fs.writeFileSync(file, statements.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    await d1File(d, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
