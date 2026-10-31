/**
 * Ruling WA-LEGACY-1: the legacy in-Store "WBS" WhatsApp bridge was DELETED (not renamed); the separate
 * Ebda WhatsApp product replaces it through the Store contract. Nothing under apps/ or packages/ may
 * name it again, and nothing may carry the inherited "fwb" prefix. Case-insensitive on purpose: the
 * old code spelled it wbs, Wbs, WBS, wbsApiKey, x-wbs-api-key, fwbStoreId.
 *
 * Applied migrations are immutable SQL and a drop migration must name what it drops, so the
 * migrations directory is exempt. Every other exception is in ALLOWLIST with its reason. The list can
 * only SHRINK: an entry whose file no longer matches fails (remove it), and the size is pinned, so
 * adding an entry means editing MAX_ALLOWLIST_SIZE in the same diff where a reviewer sees it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
export const FORBIDDEN = /wbs|fwb/i;

/** file -> why a match is not the bridge. Shrinks only. */
const ALLOWLIST: Record<string, string> = {
  'apps/api/src/lib/barcode-png/shape-masks.generated.ts':
    'base64 mask blobs: the letters "fwb" occur by chance inside the encoded data',
};
const MAX_ALLOWLIST_SIZE = 1;

const EXEMPT_PREFIX = 'packages/database/prisma/migrations/';
const BINARY = /\.(png|jpe?g|webp|avif|gif|ico|glb|woff2?|ttf|otf|pdf|mp4|webm|zip|gz|svg)$/i;

const tracked = execFileSync('git', ['ls-files', '-z', 'apps', 'packages'], {
  cwd: ROOT,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString()
  .split('\0')
  .filter(Boolean)
  .filter(f => !f.startsWith(EXEMPT_PREFIX))
  .filter(f => !f.endsWith('package-lock.json'))
  // a generated minified third-party build (pdf-lib, Ruling BUNDLE-BUDGET-7), not source
  .filter(f => f !== 'apps/api/src/cf/modules/pdf-lib.mjs');

const read = (f: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, f), 'utf8');
  } catch {
    return null; // deleted in the working tree but still indexed
  }
};

describe('no WBS / FWB references in apps/ or packages/ (Ruling WA-LEGACY-1)', () => {
  it('actually scans the source tree (not an empty-set pass)', () => {
    expect(tracked.length).toBeGreaterThan(1000);
    expect(tracked).toContain('apps/api/src/app.ts');
    expect(tracked).toContain('packages/database/prisma/schema.prisma');
  });

  it('the matcher catches each spelling the old code used', () => {
    for (const s of ['wbsApiKey', 'WBS_BASE_URL', 'x-wbs-api-key', 'Wbs', 'fwbStoreId', 'FWB'])
      expect(FORBIDDEN.test(s), s).toBe(true);
    for (const s of ['webs', 'wbc', 'Ebda WhatsApp', 'whatsapp', 'wa.me'])
      expect(FORBIDDEN.test(s), s).toBe(false);
  });

  it('no tracked path names it', () => {
    expect(tracked.filter(f => FORBIDDEN.test(f))).toEqual([]);
  });

  it('no tracked source file mentions it, except the allowlist', () => {
    const offenders: string[] = [];
    for (const f of tracked) {
      if (f in ALLOWLIST || BINARY.test(f)) continue;
      const text = read(f);
      if (text === null) continue;
      text.split('\n').forEach((line, i) => {
        if (FORBIDDEN.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      offenders,
      'The WBS bridge is gone (WA-LEGACY-1). Do not reintroduce it; Ebda WhatsApp talks to the Store through the contract.'
    ).toEqual([]);
  });

  it('every allowlisted file still needs its entry (the list only shrinks)', () => {
    expect(Object.keys(ALLOWLIST).length).toBeLessThanOrEqual(MAX_ALLOWLIST_SIZE);
    for (const [f, why] of Object.entries(ALLOWLIST)) {
      expect(tracked, `${f} is not tracked - drop it from ALLOWLIST`).toContain(f);
      expect(
        FORBIDDEN.test(read(f) ?? ''),
        `${f} no longer matches - drop it from ALLOWLIST (${why})`
      ).toBe(true);
    }
  });
});
