// Ruling WAREHOUSE-NEG-1: the deficit planner never drives a row negative, on either copy of it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planDeficit } from '../../apps/api/src/lib/warehouse-deficit';
import { planDeficit as planOnDo } from '../../packages/repo/src/do/warehouse-deficit';

describe('planDeficit', () => {
  const rows = [
    { id: 'default', quantity: 2 },
    { id: 'b', quantity: 10 },
    { id: 'c', quantity: 4 },
  ];
  it('takes from the default first, then the next rows in order', () => {
    expect(planDeficit(rows, 9)).toEqual({
      takes: [
        { id: 'default', amount: 2 },
        { id: 'b', amount: 7 },
      ],
      shortfall: 0,
    });
  });
  it('a deficit the default covers touches nothing else', () => {
    expect(planDeficit(rows, 1)).toEqual({ takes: [{ id: 'default', amount: 1 }], shortfall: 0 });
  });
  it('reports the shortfall when the rows cannot cover it, taking every positive unit', () => {
    const out = planDeficit(rows, 20);
    expect(out.shortfall).toBe(4);
    expect(out.takes.reduce((a, t) => a + t.amount, 0)).toBe(16);
  });
  it('a row that is already negative gives nothing and is never made worse', () => {
    expect(
      planDeficit(
        [
          { id: 'x', quantity: -3 },
          { id: 'y', quantity: 5 },
        ],
        2
      )
    ).toEqual({
      takes: [{ id: 'y', amount: 2 }],
      shortfall: 0,
    });
  });
  it('an empty or zero deficit is a no-op', () => {
    expect(planDeficit([], 5)).toEqual({ takes: [], shortfall: 5 });
    expect(planDeficit(rows, 0)).toEqual({ takes: [], shortfall: 0 });
  });
  it('the API copy and the Durable Object copy are the same file and give the same answers', () => {
    const a = readFileSync('apps/api/src/lib/warehouse-deficit.ts', 'utf8');
    const b = readFileSync('packages/repo/src/do/warehouse-deficit.ts', 'utf8');
    expect(a).toBe(b);
    expect(planOnDo(rows, 9)).toEqual(planDeficit(rows, 9));
  });
});
