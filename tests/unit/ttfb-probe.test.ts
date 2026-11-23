import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain .mjs ops script
import { parseProbe, classify } from '../../scripts/ops/ttfb-probe.mjs';

describe('ttfb-probe (WEB-COLD-3)', () => {
  const dump =
    'HTTP/2 200\r\ncf-ray: a58b7679ea3bab52-CDG\r\nx-demo-edge: MISS\r\nx-store-edge: MISS\r\n';
  it('reads the colo and the edge verdicts from a header dump', () => {
    expect(parseProbe(dump)).toEqual({
      colo: 'CDG',
      demoEdge: 'MISS',
      storeEdge: 'MISS',
      cfCache: null,
    });
  });
  it('labels an edge MISS as a cold render and a slow one as SLOW', () => {
    expect(classify(parseProbe(dump), 5.05)).toBe('cold-render SLOW(>=1s)');
    expect(classify({ demoEdge: 'HIT', storeEdge: 'MISS' }, 0.4)).toBe('cached');
    expect(classify({ demoEdge: 'HIT', storeEdge: 'MISS' }, 1.4)).toBe('cached SLOW(>=1s)');
    expect(classify({ demoEdge: null, storeEdge: null }, 0.3)).toBe('no-edge-cache');
  });
  it('is robust to an empty dump', () => {
    expect(parseProbe('')).toEqual({ colo: null, demoEdge: null, storeEdge: null, cfCache: null });
  });
});
