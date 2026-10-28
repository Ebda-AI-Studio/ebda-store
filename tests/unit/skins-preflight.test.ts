/**
 * Task 1 of the skin deletion (Ruling SKIN-DEL-8): the old-skin gate is READ ONLY, runs as the
 * owner role, and classifies by `look` before it looks at the template column.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const sqlText = readFileSync(path.join(root, 'scripts/skins/preflight.sql'), 'utf8');
const stripped = sqlText
  .split('\n')
  .filter(l => !l.trimStart().startsWith('--'))
  .join('\n');

// @ts-expect-error plain .mjs script, no types
const mod = (await import('../../scripts/skins/preflight.mjs')) as {
  loadStatements: (s?: string) => string[];
  isAppRoleDsn: (dsn: string) => boolean;
  isLoopbackDsn: (dsn: string) => boolean;
};

describe('scripts/skins/preflight.sql', () => {
  it('is SELECT only: no write, DDL or lock keyword (comments stripped)', () => {
    expect(stripped).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|LOCK|COPY)\b/i
    );
    expect(stripped).not.toMatch(/lock_timeout/i);
  });

  it('every statement is a SELECT or a WITH ... SELECT', () => {
    const statements = mod.loadStatements(sqlText);
    expect(statements.length).toBeGreaterThanOrEqual(5);
    for (const s of statements) expect(s).toMatch(/^(SELECT|WITH)\b/i);
  });

  it('classifies by look first: a minimal store on an Ebda look is ebda-look, never OLD-SKIN (Review Focus 1)', () => {
    const ebdaLook = stripped.indexOf("THEN 'ebda-look'");
    const oldSkin = stripped.indexOf("THEN 'OLD-SKIN'");
    expect(ebdaLook).toBeGreaterThan(-1);
    expect(oldSkin).toBeGreaterThan(-1);
    expect(ebdaLook).toBeLessThan(oldSkin);
    // and the gate count only counts stores with no Ebda look
    expect(stripped).toMatch(
      /look IS NULL OR look !~ '\^\(qamar\|souq\|jasmine\|lamma\|dahab\)\\\.'/
    );
  });

  it('never counts qa-walk-store-1010, and lists it for Ahmad instead (Ruling SKIN-DEL-4)', () => {
    expect(stripped).toContain("slug <> 'qa-walk-store-1010'");
    expect(stripped).toContain("slug = 'qa-walk-store-1010'");
  });

  it('reads the revision column that exists (document), not the plan draft name', () => {
    expect(stripped).toContain('FROM store_page_revisions');
    expect(stripped).toContain('document::text');
  });
});

describe('scripts/skins/preflight.mjs', () => {
  it('refuses the RLS-bound app role so the gate cannot pass on invisible data', () => {
    expect(mod.isAppRoleDsn('postgres://ebda_app:pw@db.example.com:5432/ebda')).toBe(true);
    expect(mod.isAppRoleDsn('postgres://neondb_owner:pw@db.example.com/ebda')).toBe(false);
    expect(mod.isAppRoleDsn('not a url')).toBe(false);
  });

  it('flags a loopback DSN as not evidence of production', () => {
    expect(mod.isLoopbackDsn('postgres://u:p@localhost:5432/x')).toBe(true);
    expect(mod.isLoopbackDsn('postgres://u:p@127.0.0.1:5432/x')).toBe(true);
    expect(mod.isLoopbackDsn('postgres://u:p@ep-abc.neon.tech/x')).toBe(false);
  });

  it('exits non-zero with a clear message when given an ebda_app DSN', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/skins/preflight.mjs'), 'postgres://ebda_app:pw@127.0.0.1:1/x'],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ebda_app');
  });
});
