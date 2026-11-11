/**
 * #605: lens-n-medium-traffic.js's overall http_req_duration threshold
 * (p(95)<500) was tighter than its own per-endpoint allowances (p(95)<800 for
 * ms_product_list — the highest-volume request, run every iteration). Since
 * the overall p95 is dominated by the request that runs every iteration, a
 * run at exactly the documented ~80-store profile was pre-destined to breach
 * the overall gate even though every per-endpoint band it names as expected
 * was met — the "measured headroom" signal was misleading by construction.
 *
 * This does not run k6 (no binary/target here); it parses the threshold
 * object each scenario file exports and asserts the overall ceiling is never
 * TIGHTER than any per-endpoint ceiling the same file declares for a
 * request that runs on every iteration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parseSource, props, isStr, nameOf } from './helpers/ts-ast';

const ROOT = path.resolve(__dirname, '../..');

function parseThresholdMs(expr: string): number | null {
  // Only the shape these scenarios use: 'p(95)<NNN'.
  const m = expr.match(/p\(95\)<(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * metricName -> p95 ceiling in ms, for every `<metric>: ['p(95)<N']` entry of the scenario's
 * `thresholds` object. AST, not brace counting over text: the object is the real `thresholds`
 * property (a comment saying "thresholds: {" cannot be mistaken for it) and a metric's ceiling is
 * a string element of its own array.
 */
function parseMetricCeilings(src: string): Record<string, number> {
  const sf = parseSource('scenario.js', src);
  const blocks = props(sf, 'thresholds').filter(p => ts.isObjectLiteralExpression(p.initializer));
  expect(blocks, 'no thresholds block found — the scenario file shape changed').toHaveLength(1);
  const out: Record<string, number> = {};
  for (const m of (blocks[0].initializer as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(m) || !ts.isArrayLiteralExpression(m.initializer)) continue;
    for (const el of m.initializer.elements) {
      const ms = isStr(el) ? parseThresholdMs(el.text) : null;
      if (ms !== null) out[nameOf(m)] = ms;
    }
  }
  return out;
}

describe('#605: loadtest overall threshold is never tighter than a per-iteration endpoint band', () => {
  const file = 'loadtests/scenarios/lens-n-medium-traffic.js';
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  const ceilings = parseMetricCeilings(src);

  it('found the metrics this test depends on (guards against a rename)', () => {
    expect(ceilings.http_req_duration).toBeGreaterThan(0);
    expect(ceilings.ms_product_list).toBeGreaterThan(0);
  });

  it('http_req_duration (overall) is >= ms_product_list — the request that runs every iteration', () => {
    // ms_product_list is documented in this same file as running on EVERY
    // iteration, so it dominates the overall http_req_duration distribution.
    // An overall ceiling tighter than that endpoint's own allowance is a
    // contradiction: the overall gate can fail even when every per-endpoint
    // band this file names as expected is met.
    expect(
      parseThresholdMs(`p(95)<${ceilings.http_req_duration}`),
      'http_req_duration threshold did not parse'
    ).not.toBeNull();
    expect(
      ceilings.http_req_duration,
      `overall http_req_duration (${ceilings.http_req_duration}ms) is tighter than ms_product_list ` +
        `(${ceilings.ms_product_list}ms), which runs every iteration and dominates the overall p95`
    ).toBeGreaterThanOrEqual(ceilings.ms_product_list);
  });

  it('matches multi-store-storm.js’s overall ceiling (the sibling scenario this one is modeled on)', () => {
    const sibling = readFileSync(
      path.join(ROOT, 'loadtests/scenarios/multi-store-storm.js'),
      'utf8'
    );
    const siblingCeilings = parseMetricCeilings(sibling);
    expect(ceilings.http_req_duration).toBe(siblingCeilings.http_req_duration);
  });
});
