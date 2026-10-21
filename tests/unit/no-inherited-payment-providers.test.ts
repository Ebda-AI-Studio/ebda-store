/**
 * Ebda is for Egypt: the inherited Gulf payment gateways (Tap, MyFatoorah, Hesabe,
 * UPayments, and the KNET method) are gone from everything that ships to a user or a
 * deployment (SP6b). Git history keeps their adapters.
 *
 * Scope: text under apps/<app>/{src,public,content}, packages/<pkg>/src, and the env / compose
 * examples. docs/, tests/, scripts/ and migrations are NOT scanned (inherited Ebda docs and
 * immutable migration history live there on purpose). A dangling import of a removed adapter is
 * a compile error, so `npm run typecheck` is the other half of this guarantee.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { listProvidersV2 } from '@api/services/payment-providers/registry';

const ROOT = path.resolve(__dirname, '../..');
const FORBIDDEN =
  /\b(myfatoorah|hesabe|upayments|knet)\b|tap payments|\bTAP_(API|SECRET|WEBHOOK)_|tap_payments|\btapApiKey\b|x-tap-signature|\btap-signature\b|tap\.provider/i;

/** repo-relative path -> why it may still name one (brand-impersonation protection, not a gateway). */
const ALLOWLIST: Record<string, string> = {};

const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', 'dist', '.turbo', 'coverage']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.mdx', '.md', '.css', '.html', '.svg', '.yml', '.yaml', '.prisma']); // prettier-ignore

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), acc);
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase()))
      acc.push(path.join(dir, entry.name));
  }
  return acc;
}

function shippedFiles(): string[] {
  const out: string[] = [];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(path.join(ROOT, group))) {
      const subs = group === 'apps' ? ['src', 'public', 'content'] : ['src'];
      for (const sub of subs) {
        const p = path.join(ROOT, group, name, sub);
        if (existsSync(p) && statSync(p).isDirectory()) walk(p, out);
      }
    }
  }
  // The schema is not under src/, and the env examples are what a deployer copies.
  out.push(path.join(ROOT, 'packages/database/prisma/schema.prisma'));
  for (const f of ['.env.example', '.env.production.example', 'docker-compose.yml']) {
    out.push(path.join(ROOT, f));
  }
  return out;
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('the inherited Gulf payment gateways are removed from Ebda', () => {
  const files = shippedFiles();

  it('scans the real thing (not an empty set)', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some(f => rel(f) === 'apps/api/src/config/index.ts')).toBe(true);
    expect(files.some(f => rel(f) === '.env.example')).toBe(true);
  });

  it('the pattern catches each forbidden form', () => {
    for (const s of [
      'MyFatoorah',
      'hesabe',
      'UPayments',
      'KNET',
      'Tap Payments',
      'TAP_API_KEY',
      'x-tap-signature',
      './tap.provider',
    ]) {
      expect(FORBIDDEN.test(s), s).toBe(true);
    }
    for (const s of ['Paymob', 'tap the button', 'Kashier', 'Fawry', 'instapay']) {
      expect(FORBIDDEN.test(s), s).toBe(false);
    }
  });

  it('no shipped file, label, icon, method, config or env entry names one', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) in ALLOWLIST) continue;
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN.test(line))
            offenders.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry is still needed', () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(FORBIDDEN.test(readFileSync(path.join(ROOT, file), 'utf8')), file).toBe(true);
    }
  });

  it('the four adapters and their tests are deleted', () => {
    for (const name of ['tap', 'myfatoorah', 'hesabe', 'upayments']) {
      expect(
        existsSync(path.join(ROOT, `apps/api/src/services/payment-providers/${name}.provider.ts`)),
        name
      ).toBe(false);
    }
    expect(existsSync(path.join(ROOT, 'apps/api/src/services/payment-providers/__tests__'))).toBe(
      false
    );
  });

  it('the provider registry is exactly COD, InstaPay and the three Egyptian gateways', () => {
    expect(
      listProvidersV2()
        .map(p => p.name)
        .sort()
    ).toEqual(['cod', 'fawry', 'instapay', 'kashier', 'paymob']);
  });

  it('the Postgres provider enum and the settings page offer exactly those too', () => {
    const schema = readFileSync(path.join(ROOT, 'packages/database/prisma/schema.prisma'), 'utf8');
    const block = schema.match(/enum PaymentProvider \{([^}]*)\}/)![1];
    expect(
      block
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .sort()
    ).toEqual(['cod', 'fawry', 'instapay', 'kashier', 'paymob']);

    const page = readFileSync(
      path.join(ROOT, 'apps/admin/src/app/stores/[id]/payment-settings/page.tsx'),
      'utf8'
    );
    // The page is driven by the provider catalog (gateways) + its manual entries, not a literal list.
    expect(page).toMatch(/PROVIDER_CATALOG/);
    expect(page).not.toMatch(/id: '[a-z]+'/);
    expect(page).not.toMatch(/comingSoon/);
  });
});
