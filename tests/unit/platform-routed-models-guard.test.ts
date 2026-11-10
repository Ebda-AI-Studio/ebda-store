/**
 * NEON-ZERO-1 N-10 guard: a routed (D1) model must never sit in an array `$transaction([...])` (the routed call is async,
 * not a PrismaPromise, and would run on the retired Postgres table), and every place in @ebda/database that hands a
 * caller a RAW transaction client must wrap it with `routeTx`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
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
    // Structural: parse each file and look only at the ELEMENTS of an array literal passed straight to
    // `$transaction(...)`, so no fixed-size text window can end early or swallow a neighbouring call.
    // Behaviour is not practical here: the property is "no call site in the whole API has this shape".
    const offenders: string[] = [];
    for (const f of walk(path.join(ROOT, 'apps/api/src'))) {
      const src = fs.readFileSync(f, 'utf8');
      if (!src.includes('$transaction')) continue;
      const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
      const touchesRouted = (n: ts.Node): boolean =>
        (ts.isPropertyAccessExpression(n) && models.includes(n.name.text)) ||
        ts.forEachChild(n, touchesRouted) === true;
      const visit = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === '$transaction' &&
          n.arguments[0] &&
          ts.isArrayLiteralExpression(n.arguments[0]) &&
          n.arguments[0].elements.some(touchesRouted)
        )
          offenders.push(path.relative(ROOT, f));
        ts.forEachChild(n, visit);
      };
      visit(sf);
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
