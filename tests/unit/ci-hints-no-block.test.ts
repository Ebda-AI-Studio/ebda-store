/**
 * Advise, never block (plan 0.4 and 4.3, Ruling CI-10): no code path in checkout, order-create or
 * booking may read a CI value. Enforced as an allowlist of the files that may import the CI hint /
 * aggregate / insight modules; anything else (cart, checkout, order, shipping, payment services and
 * routes) importing them fails here. The scanner is mutation-checked against a planted importer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../apps/api/src');
const CI_CLIENT =
  /from\s+['"][^'"]*(?:lib\/ci\/(?:hints|aggregate)[^'"]*|\/ci-(?:hints|insights|calibration)\.service)['"]/;

const ALLOWED = [
  /^routes\/ci\.routes\.ts$/,
  /^routes\/admin-ci\.routes\.ts$/,
  /^services\/ci-(hints|insights|calibration)\.service\.ts$/,
  /^lib\/inngest\/functions\/ci-aggregation\.ts$/,
  /^lib\/ci\/(hints|aggregate)\//,
  // The assistant's `customer_intelligence_settings` tool flips the store's own CI sharing switch through the same service the settings screen calls; it reads no hint and sits in no checkout / booking path.
  /^smart-layer\/tools\/ops-people\.tools\.ts$/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}
export const importersOf = (files: Array<[string, string]>) =>
  files.filter(([, text]) => CI_CLIENT.test(text)).map(([rel]) => rel);

describe('CI hints never sit in a write path', () => {
  const files = walk(SRC).map(p => [relative(SRC, p), readFileSync(p, 'utf8')] as [string, string]);

  it('only the CI routes, services and jobs import the CI client modules', () => {
    const stray = importersOf(files).filter(rel => !ALLOWED.some(a => a.test(rel)));
    expect(stray).toEqual([]);
  });

  it('the allowlist is not empty (the scanner sees the real importers)', () => {
    expect(importersOf(files)).toEqual(
      expect.arrayContaining(['routes/ci.routes.ts', 'services/ci-hints.service.ts'])
    );
  });

  it('mutation: a checkout file importing a hint is caught', () => {
    const planted: Array<[string, string]> = [
      ['services/checkout.service.ts', `import { orderCodRisk } from './ci-hints.service';`],
      ['services/order.service.ts', `import { codRiskHint } from '../lib/ci/hints/cod-risk';`],
    ];
    const stray = importersOf(planted).filter(rel => !ALLOWED.some(a => a.test(rel)));
    expect(stray).toEqual(['services/checkout.service.ts', 'services/order.service.ts']);
  });

  it('the hint routes are GETs that return advice only (no handler writes an order, shipment or booking)', () => {
    const text = readFileSync(join(SRC, 'routes/ci.routes.ts'), 'utf8');
    expect(text).not.toMatch(/prisma\.(order|shipment|payment)\.(update|create|delete)/);
    expect(text).not.toMatch(/router\.(post|delete|patch)\(/);
  });
});
