/**
 * The store-time-zone lookup must not open its own interactive Postgres
 * transaction (issue 2410). `runInTenantContext` never joins an ambient tx, so
 * `await runInTenantContext(id, () => storeTimeZone(id))` took every finance
 * report from 2 interactive transactions to 3 — for a read of `stores`, which
 * has RLS DISABLED (migration 20260609000000) and needs no tenant GUC.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API_SRC = join(__dirname, '../../apps/api/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('storeTimeZone is called bare', () => {
  it('no call site wraps it in runInTenantContext', () => {
    const offenders = walk(API_SRC).filter(f => {
      const src = readFileSync(f, 'utf8');
      return /runInTenantContext\([^)]*?,\s*(?:async\s*)?\(\)\s*=>\s*storeTimeZone\(/s.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('the finance routes still resolve the zone (the guard is not vacuous)', () => {
    const src = readFileSync(join(API_SRC, 'routes/finance.routes.ts'), 'utf8');
    expect((src.match(/await storeTimeZone\(req\.params\.storeId\)/g) ?? []).length).toBe(9);
  });
});
