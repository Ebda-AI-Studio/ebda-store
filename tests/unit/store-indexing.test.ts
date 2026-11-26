import { describe, expect, it } from 'vitest';
import { classifyResolve } from '../../apps/web/src/lib/store-indexing';

describe('classifyResolve (Ruling ROBOTS-CLOSED-1)', () => {
  it('a 404 is closed: no live storefront', () => {
    expect(classifyResolve(404, null)).toBe('closed');
  });
  it.each(['suspended', 'inactive', 'archived', 'draft', 'deleted'])('status %s is closed', st => {
    expect(classifyResolve(200, { status: st })).toBe('closed');
  });
  it('an active store is open; the demo and a merchant-hidden store are hidden, not closed', () => {
    expect(classifyResolve(200, { status: 'active' })).toBe('open');
    expect(classifyResolve(200, { status: 'active', isDemo: true })).toBe('hidden');
    expect(
      classifyResolve(200, { status: 'active', settings: { hideFromSearchEngines: true } })
    ).toBe('hidden');
  });
  it('not being able to ask is unknown, never closed', () => {
    for (const code of [500, 502, 503, 429]) expect(classifyResolve(code, null)).toBe('unknown');
    expect(classifyResolve(200, null)).toBe('unknown');
  });
});
