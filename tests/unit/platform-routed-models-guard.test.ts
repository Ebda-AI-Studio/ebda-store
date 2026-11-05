/**
 * NEON-ZERO-1 N-10 guard: a routed (D1) model must never sit in an array `$transaction([...])` (the routed call is async,
 * not a PrismaPromise, and would run on the retired Postgres table), and every place in @ebda/database that hands a
 * caller a RAW transaction client must wrap it with `routeTx`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAMILY_MODELS } from '../../apps/api/src/services/platform/cutover';

const ROOT = path.resolve(__dirname, '../..');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : walk(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });

describe('routed models and transactions', () => {
  const models = Object.values(FAMILY_MODELS).flat();

  it('no array $transaction([...]) touches a routed model', () => {
    const offenders: string[] = [];
    for (const f of walk(path.join(ROOT, 'apps/api/src'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\$transaction\(\s*\[/g)) {
        const body = src.slice(m.index!, m.index! + 1500);
        const close = body.indexOf('])');
        const block = close > 0 ? body.slice(0, close) : body;
        if (models.some(model => new RegExp(`\\.${model}\\.`).test(block)))
          offenders.push(path.relative(ROOT, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no file of @ebda/database hands a caller an unwrapped raw transaction client', () => {
    // the runtime half is the guard registered by services/platform/router.ts (tests/unit/platform-billing-d1-money.test.ts)
    const offenders: string[] = [];
    let routed = 0;
    for (const f of walk(path.join(ROOT, 'packages/database/src'))) {
      const src = fs.readFileSync(f, 'utf8');
      routed += (src.match(/routeTx\(tx\)/g) ?? []).length;
      if (/\b(?:fn|callback|cb|run)\(tx\)/.test(src) && !/tx-route\.ts$/.test(f))
        offenders.push(path.relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
    // transactionWithGucs, withTenantContext, scopeTransaction, withOwnerTx, the `$transaction` passthrough, withMoneyTx
    expect(routed).toBeGreaterThanOrEqual(6);
  });
});
