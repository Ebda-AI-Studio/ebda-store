/**
 * Ebda is Ebda AI Studio's product. No inherited brand, tenant, domain, country
 * or currency string may survive anywhere in the repository: app source, public
 * assets, shipped content, packages, CI, scripts, tests, configs and docs.
 *
 * Scope: EVERY git-tracked text file (and every tracked file PATH), minus
 *  - packages/database/prisma/migrations/** : applied migrations are immutable
 *    (Prisma checksums them); editing history would break `migrate deploy`.
 *  - this file (it spells the patterns out) and lockfile integrity lines.
 * The inherited payment-provider names (provider scan) additionally apply to
 * shipped sources only (apps/<app>/src|public|content, packages/<pkg>/src and
 * .github/workflows); docs/tests may name them to explain the removal.
 *
 * ALLOWED lists the only surviving hits, each a live wire / config contract
 * that cannot change without a coordinated deploy. Every entry must still match
 * somewhere (last test), so the list can only shrink.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SELF = 'tests/unit/no-force-branding.test.ts';

const BRAND =
  /(?<!en)(?<!in)force[ _-]?(ai|media|app|wb|website|suite)|forceai|forcemedia|PoweredByForce|force_[a-z_]+_v\d+|pecannbee|wadyaljuz|palora|kuwait|kuwaiti|\bKWD\b|الكويت|فورس/i;
// FWB without the false positives of a case-insensitive match (afwbc, fwbc).
const FWB = /(?<![A-Za-z])(?:FWB|fwb)(?![a-z])|fwb[A-Z]/;
const brandTest = (s: string): boolean => BRAND.test(s) || FWB.test(s);
const PROVIDERS = /MyFatoorah|Hesabe|UPayments|\bKNET\b/i;

/**
 * Line-level exceptions: regex + why + the EXACT files allowed to carry it
 * (tests/unit/branding-allowlist.json, regenerate with the one-liner in
 * docs/RULINGS.md BRAND-ZERO-1). A hit anywhere else, including a new file, fails.
 */
const ALLOWED: Record<string, { re: RegExp; why: string }> = {
  forceApiApp: {
    re: /(?<![A-Za-z0-9_])force-(?:api|app)\b/gi,
    why: 'JWT iss/aud claim values on every issued token (renaming logs every user out; needs a dual-accept rollout) and the live names of third-party resources (Railway service, Sentry project, Axiom dataset, Inngest app id, OTEL service name)',
  },
  hintCookie: {
    re: /\bforce-session\b/g,
    why: 'live admin/orders hint cookie name (force-session=1) read by api.ts + middleware; renaming bounces every signed-in merchant through login once',
  },
};
const ALLOW_FILES: Record<string, string[]> = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/unit/branding-allowlist.json'), 'utf8')
);

export function brandViolates(line: string, file = ''): boolean {
  if (!brandTest(line)) return false;
  let rest = line;
  for (const [name, { re }] of Object.entries(ALLOWED))
    if (!file || (ALLOW_FILES[name] ?? []).includes(file))
      rest = rest.replace(
        new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
        ''
      );
  return brandTest(rest);
}
export const providerViolates = (line: string): boolean => PROVIDERS.test(line);

const SIDECARS = [
  'tests/unit/branding-allowlist.json',
  'tests/unit/applied-migrations.json',
  // Guard tests that must NAME the forbidden strings to forbid them.
  'tests/unit/no-wbs-refs.test.ts',
  'tests/unit/email-domain-allowlist.test.ts',
  // Vendored @ebda/foundation smart-layer billing-claims: its currency lexicon NAMES foreign currencies so an unsourced amount claim
  // in any currency is refused; it never renders one (byte-pinned by foundation.lock.json).
  'packages/shared/src/foundation/smart-layer/rails/binding-claims.ts',
];
// sha1 prefixes of the migration directories already on origin/main (applied, immutable).
// Hashed so the snapshot itself carries no migration name. A migration dir NOT in this set is new
// and is scanned like any other file.
const APPLIED: string[] = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/unit/applied-migrations.json'), 'utf8')
);
function isAppliedMigration(f: string): boolean {
  const m = /^packages\/database\/prisma\/migrations\/([^/]+)\//.exec(f);
  return !!m && APPLIED.includes(createHash('sha1').update(m[1]).digest('hex').slice(0, 12));
}

const BINARY = /\.(png|jpe?g|webp|avif|gif|ico|glb|woff2?|ttf|otf|pdf|mp4|webm|zip|gz)$/i;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter(f => f !== SELF && !SIDECARS.includes(f))
  .filter(f => !isAppliedMigration(f));
const textFiles = tracked.filter(f => !BINARY.test(f));
const shipped = (f: string) =>
  /^(apps\/[^/]+\/(src|public|content)|packages\/[^/]+\/src|\.github\/workflows)\//.test(f);

describe('no inherited branding anywhere in the repository', () => {
  it('actually scans the repo (not an empty-set pass)', () => {
    expect(textFiles.length).toBeGreaterThan(2000);
    for (const must of [
      'ROADMAP.md',
      '.github/workflows/ci.yml',
      'docs/RULINGS.md',
      'scripts/backup-db.sh',
    ])
      expect(textFiles).toContain(must);
  });

  it('the patterns catch each forbidden form and spare Ebda strings', () => {
    for (const s of [
      'Force AI',
      'ForceAI-KW',
      'x.force-ai.co',
      'a.forcemediakw.com',
      'Force Media',
      'force_media',
      'force-website-builder',
      'Force Website Builder',
      'force_app',
      'pecannbee.com.kw',
      'Wadyaljuz',
      'palora',
      'KWD',
      'kwd',
      'Kuwait',
      'Kuwaiti',
      'الكويت',
      'FWB',
      'fwb_x',
      'fwb-eu',
      'fwbStoreId-x force ai',
    ])
      expect(brandViolates(s), s).toBe(true);
    for (const s of [
      'Ebda by Ebda AI Studio',
      'EGP',
      'Egypt',
      'Paymob',
      'InstaPay',
      'afwbc',
      'KWDX',
      'enforce',
      'reinforce app',
    ])
      expect(brandViolates(s), s).toBe(false);
    for (const s of ["audience: 'ebda-app'", "issuer: 'ebda-api'"])
      expect(brandViolates(s), s).toBe(false);
    for (const s of ['MyFatoorah', 'hesabe', 'UPayments', 'KNET'])
      expect(providerViolates(s), s).toBe(true);
  });

  it('no tracked file PATH names an inherited brand', () => {
    expect(tracked.filter(f => brandTest(f))).toEqual([]);
  });

  it('no tracked file CONTENT names an inherited brand, tenant, domain, country or currency', () => {
    const offenders: string[] = [];
    for (const f of textFiles) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (line.includes('sha512-')) return;
        if (brandViolates(line, f) || (shipped(f) && providerViolates(line)))
          offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      offenders,
      'Inherited branding found. Use BRAND from @ebda/shared (packages/shared/src/brand), EGP and Egypt.'
    ).toEqual([]);
  });

  it('every ALLOWED contract still occurs in each file listed for it (the list only shrinks)', () => {
    for (const [name, { re, why }] of Object.entries(ALLOWED)) {
      const files = ALLOW_FILES[name] ?? [];
      expect(files.length, `${name} has no files - drop the allowance (${why})`).toBeGreaterThan(0);
      for (const f of files) {
        expect(tracked, `${f} (${name}) is not tracked`).toContain(f);
        const src = readFileSync(path.join(ROOT, f), 'utf8');
        expect(
          new RegExp(re.source, re.flags.replace('g', '')).test(src),
          `${f} no longer needs ${name} - drop it from branding-allowlist.json (${why})`
        ).toBe(true);
      }
    }
  });

  it('applied-migration skip covers only the snapshot: a new migration dir is scanned', () => {
    expect(
      isAppliedMigration('packages/database/prisma/migrations/20990101000000_new_one/migration.sql')
    ).toBe(false);
    expect(APPLIED.length).toBeGreaterThan(100);
  });
});
