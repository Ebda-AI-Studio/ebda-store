/**
 * audit-followup #1848: docs/ROLLBACK.md's restore block ran `npm run
 * db:rls`, a script that has never existed in package.json (only
 * db:generate/migrate/push/seed/studio) — the correct command
 * (`prisma migrate deploy --schema=...`) already lived one file over in
 * docs/DB-BACKUP-RESTORE.md. Followed literally during a real restore, the
 * stale command would 404 the shell and leave RLS policies unapplied on a
 * branch about to be promoted to primary: cross-tenant exposure.
 *
 * This is a doc-drift class, not a one-off typo, so the guard is generic:
 * every `npm run <script>` referenced in a restore/rollback runbook must
 * name a script that actually exists in package.json.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../..');

const RUNBOOKS = ['docs/ROLLBACK.md', 'docs/DB-BACKUP-RESTORE.md'];

function extractNpmRunScripts(markdown: string): string[] {
  // Only look inside fenced code blocks — prose mentioning "npm run x" in an
  // explanatory sentence isn't a command anyone will paste into a shell.
  const codeBlocks = markdown.match(/```[\s\S]*?```/g) ?? [];
  const scripts = new Set<string>();
  for (const block of codeBlocks) {
    for (const match of block.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      scripts.add(match[1]);
    }
  }
  return [...scripts];
}

describe('restore/rollback runbooks only reference real npm scripts', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const knownScripts = new Set(Object.keys(pkg.scripts));

  for (const runbook of RUNBOOKS) {
    it(`every "npm run <script>" in ${runbook} exists in package.json`, () => {
      const markdown = readFileSync(join(REPO_ROOT, runbook), 'utf8');
      const referenced = extractNpmRunScripts(markdown);
      const missing = referenced.filter(s => !knownScripts.has(s));
      expect(missing, `${runbook} references nonexistent script(s): ${missing.join(', ')}`).toEqual(
        []
      );
    });
  }

  it('specifically: db:rls does not exist and must never be reintroduced', () => {
    expect(knownScripts.has('db:rls')).toBe(false);
    for (const runbook of RUNBOOKS) {
      const markdown = readFileSync(join(REPO_ROOT, runbook), 'utf8');
      expect(markdown, `${runbook} still runs the nonexistent db:rls script`).not.toMatch(
        /npm run db:rls\b/
      );
    }
  });
});

/**
 * scoped-audit P1 follow-up (blocked PR #1942): the FIRST replacement for
 * `db:rls` was `prisma migrate deploy` alone, asserted to "re-create every
 * policy". That's false — a full pg_dump restore recreates
 * `_prisma_migrations` fully-applied, so `migrate deploy` sees nothing
 * pending and reports success having run zero SQL, regardless of whether
 * RLS policies actually survived the restore. Both runbooks must MEASURE
 * policy state (query pg_policies + the deny-all detector from
 * docs/plans/done/2026-07-02-rls-cutover.md Phase 0) rather than infer it from a
 * clean `migrate deploy` exit code — and must never again narrate that
 * `migrate deploy` alone is what re-creates the policies.
 */
describe('restore runbooks measure RLS state instead of trusting migrate deploy', () => {
  for (const runbook of RUNBOOKS) {
    const markdown = readFileSync(join(REPO_ROOT, runbook), 'utf8');

    it(`${runbook} queries pg_policies to verify RLS survived the restore`, () => {
      expect(markdown).toMatch(/pg_policies/);
      expect(markdown).toMatch(/schemaname\s*=\s*'public'/);
    });

    it(`${runbook} queries for RLS-enabled tables with zero policies (deny-all)`, () => {
      expect(markdown).toMatch(/relrowsecurity/);
      expect(markdown).toMatch(/having\s+count\(p\.polname\)\s*=\s*0/i);
    });

    it(`${runbook} does not claim migrate deploy alone re-creates the policies`, () => {
      expect(markdown).not.toMatch(/re-creates every policy/i);
    });

    it(`${runbook} sets both DATABASE_URL and DIRECT_URL on the migrate deploy call`, () => {
      // schema.prisma's datasource reads DATABASE_URL directly — DIRECT_URL
      // alone either fails closed or silently targets the ambient env's
      // DATABASE_URL (production).
      expect(markdown).toMatch(
        /DATABASE_URL="\$URL"\s+DIRECT_URL="\$URL"\s+npx prisma migrate deploy/
      );
    });
  }
});
