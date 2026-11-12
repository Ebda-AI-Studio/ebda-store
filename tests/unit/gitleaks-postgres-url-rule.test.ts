/**
 * Ruling CI-MAC-TRUFFLE-1 (2026-11-11). Two secret-scan guarantees for Postgres connection URLs:
 *
 * 1. gitleaks' `ebda-postgres-url-password` rule (.gitleaks.toml) fires on a real-host URL with an inline password. The
 *    built-in ruleset does not (measured: a committed Neon-shaped URL gave "no leaks found"), and trufflehog only fails on
 *    URLs it can VERIFY from the runner, so an unverifiable real URL used to pass both scanners. Loopback hosts, the
 *    reserved example/test domains and placeholders stay silent.
 * 2. The Mac runner's trufflehog step skips EXACTLY the files in .github/trufflehog-mac-exclude-paths.txt (the
 *    db.example.com fixtures that report as verified from the Mac, main run 43112327669); nothing else is excluded.
 *
 * Fixture URLs are assembled at runtime so this file never contains a contiguous secret-shaped URL itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const toml = readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8');

// the rule block: from its [[rules]] header to the end of its allowlists block
const block = toml.slice(toml.indexOf('id = "ebda-postgres-url-password"'));
const lit = (s: string) => [...s.matchAll(/'''(.*?)'''/g)].map(m => m[1]);
const ruleRe = new RegExp(lit(/regex = '''.*?'''/.exec(block)![0])[0]);
const allowStart = block.indexOf('[[rules.allowlists]]');
const allowRes = lit(
  block.slice(allowStart, block.indexOf(']\n', block.indexOf('regexes = [', allowStart)) + 1)
).map(r => new RegExp(r));

/** What gitleaks reports for one line: the rule matches and no allowlist regex matches the match (regexTarget=match). */
function fires(line: string): boolean {
  const m = ruleRe.exec(line);
  return !!m && !allowRes.some(a => a.test(m[0]));
}

const url = (
  scheme: string,
  user: string,
  pw: string,
  host: string,
  rest = '/neondb?sslmode=require'
) => `${scheme}://${user}:${pw}@${host}${rest}`;
const NEON_PW = ['Xk9vQ2mR', '7tLp4wZs'].join('');
const KNOWN_BAD = [
  url('postgresql', 'app_user', NEON_PW, 'ep-cool-db-123456.eu-central-1.aws.neon.tech'),
  url('postgres', 'svc', NEON_PW, 'db.internal.ebda.app', ':5432/x'),
];
const KNOWN_GOOD = [
  url('postgresql', 'app_user', NEON_PW, 'localhost', ':5432/force_test'),
  url('postgresql', 'app_user', NEON_PW, '127.0.0.1', ':5432/force_test'),
  url('postgres', 'u', NEON_PW, 'db.example.com', ':5432/ebda'),
  url('postgresql', 'USER', 'PASSWORD', 'ep-xxxx.REGION.aws.neon.tech'),
  url('postgresql', 'neondb_owner', 'xxxx', 'ep-foo-pooler.eu-central-1.aws.neon.tech'),
  url('postgresql', 'u', 'p', 'ep-cool-1.neon.tech'),
  url('postgresql', 'test', 'test', 'localhost', ':${PORT}/db'),
  url('postgres', 'postgres', '[YOUR-PASSWORD]', 'db.YOUR_PROJECT.supabase.co'),
];

describe('gitleaks ebda-postgres-url-password rule', () => {
  it('parses the rule and its allowlist from .gitleaks.toml (not a silent empty set)', () => {
    expect(ruleRe.source).toContain('postgres');
    expect(allowRes.length).toBeGreaterThanOrEqual(4);
  });
  it.each(KNOWN_BAD.map((u, i) => [i, u] as const))('fires on real-host URL #%i', (_i, u) => {
    expect(fires(`DATABASE_URL=${u}`)).toBe(true);
  });
  it.each(KNOWN_GOOD.map((u, i) => [i, u] as const))(
    'stays silent on loopback/example/placeholder URL #%i',
    (_i, u) => {
      expect(fires(`DATABASE_URL=${u}`)).toBe(false);
    }
  );

  // End to end through the real binary when it is installed (the Mac runner and dev machines; hosted ubuntu has none).
  const gitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  it.skipIf(gitleaks.status !== 0)(
    'the gitleaks binary agrees: one finding for the Neon URL, none for localhost',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'glpg-'));
      writeFileSync(path.join(dir, 'bad.env'), `DATABASE_URL=${KNOWN_BAD[0]}\n`);
      writeFileSync(path.join(dir, 'good.env'), `DATABASE_URL=${KNOWN_GOOD[0]}\n`);
      const report = path.join(dir, 'r.json');
      spawnSync(
        'gitleaks',
        [
          'detect',
          '--no-git',
          '--no-banner',
          '--source',
          dir,
          '--config',
          path.join(ROOT, '.gitleaks.toml'),
          '--report-format',
          'json',
          '--report-path',
          report,
          '--log-level',
          'error',
        ],
        { encoding: 'utf8' }
      );
      const findings = JSON.parse(readFileSync(report, 'utf8')) as Array<{
        RuleID: string;
        File: string;
      }>;
      const ours = findings.filter(f => f.RuleID === 'ebda-postgres-url-password');
      expect(ours.map(f => path.basename(f.File))).toEqual(['bad.env']);
    }
  );
});

describe('the Mac trufflehog exclude list is exact (Ruling CI-MAC-TRUFFLE-1)', () => {
  const lines = readFileSync(path.join(ROOT, '.github/trufflehog-mac-exclude-paths.txt'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const res = lines.map(l => new RegExp(l));
  const excluded = (p: string) => res.some(r => r.test(p));

  it('lists exactly the file that produced the verified hits in run 43112327669', () => {
    expect(lines).toEqual(['^tests/unit/skins-preflight\\.test\\.ts$']);
  });
  it('excludes that file and nothing else', () => {
    expect(excluded('tests/unit/skins-preflight.test.ts')).toBe(true);
    for (const p of [
      'tests/unit/db-guard.test.ts',
      'tests/unit/skins-preflight.test.tsx',
      'x/tests/unit/skins-preflight.test.ts',
      'apps/api/src/config/index.ts',
      '.env.example',
    ]) {
      expect(excluded(p), p).toBe(false);
    }
  });
  it('the Mac trufflehog step passes the list, and the Linux action is unchanged', () => {
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('--exclude-paths .github/trufflehog-mac-exclude-paths.txt');
    expect(ci).not.toMatch(/--exclude-detectors/);
  });
});
