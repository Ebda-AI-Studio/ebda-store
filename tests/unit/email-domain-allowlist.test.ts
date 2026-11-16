/**
 * Placeholder / sample email addresses must never sit on a domain somebody could own (Ruling
 * WA-LEGACY-1: the legacy WhatsApp bridge minted `wa-<digits>@placeholder.<registered domain>` and a
 * confirmation email with order PII could have been delivered to that third party).
 *
 *  1. In apps/ and packages/ (non-test) source, every `local@domain` string sits on an allow-listed
 *     domain: ours, a provider the code legitimately names, or an RFC 2606 reserved name.
 *  2. No Force / forcestore domain appears anywhere in the repo's source.
 *  3. The send path refuses reserved-TLD recipients (tests/unit/undeliverable-email.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Domains a non-test source file may put after an `@`. Add one only with a reason. */
const ALLOWED_DOMAINS: Record<string, string> = {
  'ebda.app': 'our own domain',
  'example.com': 'RFC 2606 documentation domain',
  'gmail.com': 'free-mail provider named in PII-masking examples and domain lists',
  'sub.mailinator.com': 'disposable-email blocklist entry',
  'demostore.com': 'demo seed data (never delivered: demo stores send nothing)',
  'store.com': 'sample value in a URL-validation doc comment',
  'x.com': 'sample value in comments / URL examples',
  'b.com': 'sample value in a PII-masking example',
  'vercel.com': 'sender allow-list of the alert poller',
  'uptimerobot.com': 'sender allow-list of the alert poller',
  'github.com': 'sender allow-list of the alert poller',
  'sentry.io': 'sender allow-list of the alert poller',
  'posthog.com': 'sender allow-list of the alert poller',
  'railway.app': 'sender allow-list of the alert poller',
  'neon.tech': 'sender allow-list of the alert poller',
  'cloudflare.com': 'sender allow-list of the alert poller',
  'notify.cloudflare.com': 'sender allow-list of the alert poller',
  'user.uptimerobot.com': 'sender allow-list of the alert poller',
  'shipblu.com': 'carrier support address in the provider catalog',
};
const RESERVED = /\.(?:invalid|test|example|localhost)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const FORCE_DOMAIN = /forcestore\.|forcemediakw\.|force-ai\.co|forceai\.[a-z]/i;

const isTest = (f: string) =>
  /(\.test\.|\.spec\.|\/__tests__\/|\/test\/|\/workers-test\/|\/workers-do\/|\/e2e\/)/.test(f);
const BINARY = /\.(png|jpe?g|webp|avif|gif|ico|glb|woff2?|ttf|otf|pdf|mp4|webm|zip|gz|svg)$/i;

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter(f => !BINARY.test(f))
  .filter(f => !f.endsWith('package-lock.json') && !f.includes('/migrations/'))
  .filter(f => !f.startsWith('graphify-out/'));

const read = (f: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, f), 'utf8');
  } catch {
    return null;
  }
};

describe('email domains in source (Ruling WA-LEGACY-1)', () => {
  const source = tracked.filter(
    f =>
      /^(apps|packages)\/[^/]+\/(?!.*generated)/.test(f) &&
      !isTest(f) &&
      !/\/foundation\/vectors\//.test(f) // vendored cross-product test vectors (an e-mail inside a mask test, an e-mail-shaped hostile link)
  );

  it('actually scans source (not an empty-set pass)', () => {
    expect(source.length).toBeGreaterThan(1000);
  });

  it('every address in non-test source is on an allow-listed or reserved domain', () => {
    const offenders: string[] = [];
    for (const f of source) {
      const text = read(f);
      if (text === null) continue;
      for (const m of text.matchAll(EMAIL)) {
        const d = m[1].toLowerCase();
        if (d in ALLOWED_DOMAINS || RESERVED.test(d)) continue;
        // `@db.VarChar`-style Prisma attributes and package scopes have no local part, so they never match.
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(
      offenders,
      'Use @placeholder.invalid / an example domain, or allow-list with a reason.'
    ).toEqual([]);
  });

  it('every allow-listed domain is still used (the list only shrinks)', () => {
    const used = new Set<string>();
    for (const f of source) {
      const text = read(f);
      if (text === null) continue;
      for (const m of text.matchAll(EMAIL)) used.add(m[1].toLowerCase());
    }
    expect(Object.keys(ALLOWED_DOMAINS).filter(d => !used.has(d))).toEqual([]);
  });

  it('no Force / forcestore domain anywhere in source, tests or configs', () => {
    const offenders: string[] = [];
    for (const f of tracked) {
      if (f.startsWith('docs/') || f.startsWith('tests/unit/no-force-branding')) continue;
      if (f === 'tests/unit/email-domain-allowlist.test.ts') continue;
      const text = read(f);
      if (text === null) continue;
      text.split('\n').forEach((line, i) => {
        if (FORCE_DOMAIN.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the matcher flags a registered placeholder domain and spares reserved ones', () => {
    const hit = (s: string) => [...s.matchAll(EMAIL)].map(m => m[1].toLowerCase());
    expect(hit('wa-1@placeholder.forcestore.kw')).toEqual(['placeholder.forcestore.kw']);
    expect(RESERVED.test('placeholder.invalid')).toBe(true);
    expect(RESERVED.test('placeholder.forcestore.kw')).toBe(false);
  });
});
