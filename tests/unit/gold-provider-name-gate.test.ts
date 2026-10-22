/**
 * Gold-rate pricing, Task 11 (Ruling B5-15): the provider-anonymity gate. A feed provider's name may
 * appear only in apps/api/src/services/gold-rate/feed/**, docs/ENVIRONMENT.md, docs/RULINGS.md and the
 * ONE admin attribution component (the exchange-rate source's licence asks for a link in the admin).
 * Everything shopper-facing, every email and every marketing page says "the automatic rate". The
 * pattern list is exported by the adapter, so a source change updates the gate with it.
 */
import { describe, it, expect } from 'vitest';
import {
  readdirSync,
  readFileSync,
  statSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROVIDER_NAME_PATTERNS } from '../../apps/api/src/services/gold-rate/feed/adapter';

const ROOT = path.resolve(__dirname, '../..');
const EXEMPT = 'apps/admin/src/app/stores/[id]/gold-rates/_components/RateAttribution.tsx';
const SCANNED = [
  'apps/web/src',
  'apps/admin/src',
  'apps/marketing',
  'apps/api/src/services/email-templates',
  'packages/shared/src',
];
const EXT = /\.(tsx?|jsx?|mjs|json|html|md|mdx|css|txt)$/;
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', '.open-next', '.wrangler']);
const RE = new RegExp(PROVIDER_NAME_PATTERNS.join('|'), 'i');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (EXT.test(name)) yield full;
  }
}
/** Files under `roots` whose text names a provider, excluding the one exact exempt path. */
export function offenders(roots: string[], rootDir = ROOT, exempt = EXEMPT): string[] {
  const out: string[] = [];
  for (const r of roots) {
    const abs = path.join(rootDir, r);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const f of walk(abs)) {
      const rel = path.relative(rootDir, f).split(path.sep).join('/');
      if (rel === exempt) continue;
      if (RE.test(readFileSync(f, 'utf8'))) out.push(rel);
    }
  }
  return out;
}

describe('the provider-name gate', () => {
  it('the pattern list covers every source the adapters use', () => {
    const urls = [
      'api.gold-api.com',
      'open.er-api.com',
      'cdn.jsdelivr.net',
      'latest.currency-api.pages.dev',
      '@fawazahmed0/currency-api',
      'exchangerate-api.com',
    ];
    for (const u of urls) expect(RE.test(u), u).toBe(true);
    // the unrelated FX-rates admin page must NOT trip it
    expect(RE.test('Record exchange rates for non-EGP transactions')).toBe(false);
  });
  it('no storefront, admin, email, marketing or shared file names a provider (outside the one exempt file)', () => {
    expect(offenders(SCANNED)).toEqual([]);
  });
  it('the exempt file exists, carries the attribution link, and is matched by exact path', () => {
    const src = readFileSync(path.join(ROOT, EXEMPT), 'utf8');
    expect(src).toContain('https://www.exchangerate-api.com');
    expect(src).toContain('Rates By Exchange Rate API');
    expect(RE.test(src)).toBe(true); // it is exempt BECAUSE it names the provider
  });

  describe('negative controls (the gate can fail)', () => {
    it.each([
      ['apps/web/src/x.tsx', "export const s = 'Powered by Exchange Rate API';"],
      ['apps/api/src/services/email-templates/x.ts', "export const s = 'via open.er-api.com';"],
      ['apps/marketing/x.html', '<p>fawazahmed0</p>'],
      ['packages/shared/src/x.ts', "export const u = 'https://cdn.jsdelivr.net/npm/x';"],
      [
        'apps/admin/src/app/stores/[id]/gold-rates/_components/Sibling.tsx',
        "export const s = 'er-api';",
      ],
    ])('%s', (rel, text) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'gold-gate-'));
      try {
        const file = path.join(dir, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
        expect(offenders(SCANNED, dir)).toEqual([rel]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it('removing the exemption makes the real exempt file an offender', () => {
      expect(offenders(['apps/admin/src/app/stores'], ROOT, 'no/such/file')).toContain(EXEMPT);
    });
  });
});
