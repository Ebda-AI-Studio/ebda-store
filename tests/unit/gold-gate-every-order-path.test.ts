/**
 * Gold-rate pricing, Task 12 (Ruling B5-17): a gold price is judged on EVERY path that writes an order
 * line, and a new path cannot slip in unguarded. The sites that create an order (and so its items) are
 * listed here; each enclosing file must run the gate BEFORE the write, re-check the rate rows inside
 * the money transaction, and store the snapshot. A new `order.create` / `orderItem.create` site anywhere
 * in apps/api/src turns this red until it is added and guarded.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const API_SRC = path.resolve(__dirname, '../../apps/api/src');

/** The order-creating entry points (shopper + MCP agent, admin manual order). */
const KNOWN_SITES: Record<string, string> = {
  'services/order.service.ts': 'OrderService.create and OrderService.createAdminOrder',
};

const SITE = /\b(?:order|orderItem)\s*\.\s*(?:create|createMany)\s*\(/g;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield full;
  }
}

/** Files (relative to apps/api/src) with an order / order-item create call, with the call count. */
export function findOrderCreateSites(root: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of walk(root)) {
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const n = (src.match(SITE) ?? []).length;
    if (n > 0) out.set(path.relative(root, f).split(path.sep).join('/'), n);
  }
  return out;
}

/** Whether `src` guards its order writes: gate before, rate re-check inside the transaction, snapshot stored. */
export function isGuarded(src: string, expectedGateCalls: number): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const problems: string[] = [];
  const gates = (code.match(/assertGoldLinesPriceable\(/g) ?? []).length;
  const rechecks = (code.match(/assertSameRates\(/g) ?? []).length;
  if (gates < expectedGateCalls)
    problems.push(`gate called ${gates}x, expected ${expectedGateCalls}`);
  if (rechecks < expectedGateCalls)
    problems.push(`rate re-check called ${rechecks}x, expected ${expectedGateCalls}`);
  if (!/goldSnapshot/.test(code)) problems.push('no goldSnapshot written');
  return problems;
}

describe('every path that writes an order line runs the gold gate', () => {
  const sites = findOrderCreateSites(API_SRC);

  it('the sites are exactly the known entry points (a new site must be added here AND guarded)', () => {
    expect([...sites.keys()].sort()).toEqual(Object.keys(KNOWN_SITES).sort());
    // order.service has two order.create calls (create + createAdminOrder)
    expect(sites.get('services/order.service.ts')).toBe(2);
  });

  it('each enclosing file runs the gate before the write, re-checks the rates in the transaction, and stores the snapshot', () => {
    for (const [file, calls] of sites) {
      const src = readFileSync(path.join(API_SRC, file), 'utf8');
      expect(isGuarded(src, calls), file).toEqual([]);
    }
  });

  it('checkout and the admin order pass requireQuote correctly: checkout requires a quote, the admin path does not', () => {
    const order = readFileSync(path.join(API_SRC, 'services/order.service.ts'), 'utf8');
    expect(order).toMatch(/requireQuote: requestContext\?\.dryRun !== true/);
    expect(order).toMatch(/requireQuote: false/);
  });

  describe('negative controls (the scan can fail)', () => {
    it('a file with an unguarded order.create is detected', () => {
      const bogus = `async function sneaky() { await tx.order.create({ data: { items: { create: [] } } }); }`;
      expect((bogus.match(SITE) ?? []).length).toBe(1);
      expect(isGuarded(bogus, 1).length).toBeGreaterThan(0);
    });
    it('a commented-out gate does not count', () => {
      const src = `// assertGoldLinesPriceable(db)\n/* assertSameRates(tx) */\nawait tx.order.create({});\nconst x = { goldSnapshot: 1 };`;
      expect(isGuarded(src, 1)).toEqual([
        'gate called 0x, expected 1',
        'rate re-check called 0x, expected 1',
      ]);
    });
    it('a guarded file passes', () => {
      const src = `await assertGoldLinesPriceable(a); await assertSameRates(b); const s = { goldSnapshot: 1 }; await tx.order.create({});`;
      expect(isGuarded(src, 1)).toEqual([]);
    });
  });
});
