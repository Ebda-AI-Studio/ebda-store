// Ruling CUTOVER-5: the runbook is checked against the code it describes. A flag, secret, script or refusal that
// the cutover depends on must be named in docs/runbooks/cutover-cf.md; a refusal the code adds must be documented
// in docs/cf/*.md (that is the list go/no-go row 6 makes Ahmad accept).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');
const runbook = read('docs/runbooks/cutover-cf.md');

const walk = (d: string, out: string[] = []) => {
  for (const e of fs.readdirSync(path.join(repo, d), { withFileTypes: true })) {
    const rel = path.join(d, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(rel);
  }
  return out;
};

describe('cutover runbook parity', () => {
  it('names every control the sequence depends on', () => {
    for (const needle of [
      'a71a521d-0dee-4741-9430-635ca56b0192', // D1 ebda-platform
      '/api/v1/health', // super_admin counts, not public /health
      'OPS_HEALTH_TOKEN',
      'WRITES_FROZEN',
      'JOBS_ON_DO',
      'JOBS_CF_ALARMS',
      'CUTOVER_IMPORT_SECRET',
      'CUTOVER-4',
      'CUTOVER-5',
      'neon-decommission.md',
      'rehearse-cutover.sh',
      'REHEARSAL PASS',
      '*_NOT_ON_DO',
      'read-only',
      '7 days',
    ])
      expect(runbook, needle).toContain(needle);
  });

  it('every flag the code reads for the freeze and the jobs switch exists in wrangler.jsonc', () => {
    const w = read('apps/api/wrangler.jsonc');
    for (const v of ['WRITES_FROZEN', 'JOBS_ON_DO', 'JOBS_CF_ALARMS'])
      expect(w, v).toContain(`"${v}"`);
  });

  it('does not tell anyone to pause Inngest (it no longer exists)', () => {
    expect(runbook).not.toMatch(/pause inngest|inngest dashboard/i);
  });

  it('every scripts/cf/*.mjs entry point the runbook uses exists, and every script it names is real', () => {
    for (const m of runbook.matchAll(/scripts\/cf\/([a-z-]+\.(?:mjs|sh))/g))
      expect(fs.existsSync(path.join(repo, 'scripts/cf', m[1])), m[0]).toBe(true);
  });

  it('every *_NOT_ON_DO refusal in apps/api is documented in docs/cf (the residual list Ahmad accepts)', () => {
    const codes = new Set<string>();
    for (const f of walk('apps/api/src'))
      for (const m of read(f).matchAll(/'([A-Z][A-Z_]*_NOT_ON_DO)'/g)) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(3);
    const docs = fs
      .readdirSync(path.join(repo, 'docs/cf'))
      .filter(f => f.endsWith('.md'))
      .map(f => read(path.join('docs/cf', f)))
      .join('\n');
    expect([...codes].filter(c => !docs.includes(c))).toEqual([]);
  });

  it('the rehearsal script still ends in the PASS line the runbook checks for, and refuses Neon', () => {
    const sh = read('scripts/cf/rehearse-cutover.sh');
    expect(sh).toContain('REHEARSAL PASS');
    expect(sh).toMatch(/neon\.tech/);
    expect(sh).not.toMatch(/--allow-prod/);
  });
});
