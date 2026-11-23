/**
 * GHSA-7589-6fvf-x4pw: ReDoS in effect's Schema.TemplateLiteral (effect <= 3.22.0).
 * effect is pulled only by @prisma/config (exact pin 3.21.0), so the root
 * package.json override is the fix. This pins the lockfile so the vulnerable
 * version cannot come back (it would fail the CI npm audit gate otherwise).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PATCHED = '3.22.1';

function cmp(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

describe('GHSA-7589-6fvf-x4pw effect ReDoS', () => {
  it('GHSA-7589-6fvf-x4pw: every effect entry in package-lock.json is >= 3.22.1', () => {
    const lock = JSON.parse(
      readFileSync(resolve(__dirname, '../../package-lock.json'), 'utf8')
    ) as { packages: Record<string, { version?: string }> };
    const entries = Object.entries(lock.packages).filter(
      ([k]) => k === 'node_modules/effect' || k.endsWith('/node_modules/effect')
    );
    expect(entries.length).toBeGreaterThan(0);
    const vulnerable = entries
      .filter(([, v]) => cmp(v.version ?? '0.0.0', PATCHED) < 0)
      .map(([k, v]) => `${k}@${v.version}`);
    expect(vulnerable).toEqual([]);
  });
});
