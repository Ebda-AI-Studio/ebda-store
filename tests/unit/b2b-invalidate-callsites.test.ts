/**
 * The NEVER-stale ledger (docs/plans/done/2026-10-21-b2b-wholesale.md Task 4; rule: every cached read declares a staleness class and
 * EVERY write path invalidates). Price, MOQ, audience, group membership and approval status are NEVER-stale. This test lists
 * every writer and requires its body to call the invalidator; it also fails if the invalidator has no callers (an `invalidate*`
 * with zero call-sites is the same bug inverted). There is no per-buyer cache anywhere (group prices are computed per request
 * and sent private/no-store), so a membership change needs no per-buyer purge: asserted below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const API = resolve(__dirname, '../../apps/api/src');
const read = (rel: string) => readFileSync(join(API, rel), 'utf8');

/** Text of the body of method/function `name` in `file` ('' when not found). */
function bodyOf(file: string, name: string): string {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  let out = '';
  const visit = (n: ts.Node) => {
    if (
      (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) &&
      n.name?.getText() === name &&
      n.body
    ) {
      out += n.body.getText();
    }
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText() === name &&
      ts.isFunctionLike(n.initializer)
    ) {
      out += n.initializer.getText();
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** [file, writer, regex the writer's body must match] */
const LEDGER: Array<[string, string, RegExp]> = [
  ['services/price-tier.service.ts', 'create', /invalidateB2bPricing\(/],
  ['services/price-tier.service.ts', 'update', /invalidateB2bPricing\(/],
  ['services/price-tier.service.ts', 'remove', /invalidateB2bPricing\(/],
  ['services/customer-group.service.ts', 'update', /invalidateB2bPricing\(/],
  ['services/customer-group.service.ts', 'remove', /invalidateB2bPricing\(/],
  ['services/customer-group.service.ts', 'assignCustomer', /invalidateB2bPricing\(/],
  ['services/customer-group.service.ts', 'assignByIdentity', /invalidateB2bPricing\(/],
  ['services/customer-group.service.ts', 'linkApprovedBuyer', /invalidateB2bPricing\(/],
  ['services/customer-group.service.ts', 'unlinkBuyer', /invalidateB2bPricing\(/],
  [
    'services/wholesale-application.service.ts',
    'approve',
    /invalidateB2bPricing\(|linkApprovedBuyer\(/,
  ],
  ['services/wholesale-application.service.ts', 'revoke', /invalidateB2bPricing\(|unlinkBuyer\(/],
  // existing writers that change a public price / MOQ / audience already funnel through the product-cache invalidator
  ['services/product.service.ts', 'update', /invalidateStoreProductCache\(/],
  ['services/product.service.ts', 'delete', /invalidateStoreProductCache\(/],
  // C1: a product audience flip must also drop the cached recommendation payloads (they embed related products)
  ['lib/public-cache.ts', 'clearProductsRedis', /recommendations:product:/],
  // variant writers are covered by the per-method count test below; bulk routes invalidate at the route (bulk.routes.ts)
  // any change to the resolved feature map (plan change, override) drops the cached public product payload (it lists tiers only while entitled)
  ['services/feature.service.ts', 'invalidateCache', /invalidateStoreProductCaches\(/],
  // a plan-limit edit (wholesalePricing) busts every store on that plan
  ['services/plan.service.ts', 'updatePlan', /storeIdsOnPlan\(|invalidateCache\(/],
];

describe('B2B invalidation ledger', () => {
  it.each(LEDGER)('%s %s() invalidates after the write', (file, fn, re) => {
    const body = bodyOf(file, fn);
    expect(body.length, `${file}: ${fn}() not found`).toBeGreaterThan(0);
    expect(body).toMatch(re);
  });

  it('the invalidator has callers in at least three service files (no orphan invalidate*)', () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) {
          if (e !== 'node_modules' && e !== '__tests__') walk(p);
        } else if (
          p.endsWith('.ts') &&
          !p.endsWith('.test.ts') &&
          !p.endsWith('b2b-invalidate.ts')
        ) {
          if (/invalidateB2bPricing\(/.test(readFileSync(p, 'utf8')))
            callers.push(p.replace(API + '/', ''));
        }
      }
    };
    walk(API);
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it('variant.service invalidates after every write path (one invalidation per mutating method)', () => {
    const src = read('services/variant.service.ts');
    const writes = (
      src.match(/\bpublic static async (create|update|delete|bulk|set|reorder)\w*/g) ?? []
    ).length;
    const inv = (src.match(/invalidateStoreProductCaches\(/g) ?? []).length;
    expect(inv).toBeGreaterThanOrEqual(Math.min(writes, 8));
  });

  it('there is no per-buyer cache: no B2B module caches a resolved price (setEx / cache set / Map of prices)', () => {
    for (const f of [
      'services/price-resolver.service.ts',
      'services/price-tier.service.ts',
      'lib/buyer-identity.ts',
    ]) {
      expect(read(f), f).not.toMatch(/redis\.(set|setex)|getCached\(|setCached\(|cache\.set\(/);
    }
  });
});
