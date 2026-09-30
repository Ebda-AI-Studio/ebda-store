/**
 * #1892 — the brand-facts sweep persists only allowlisted keys in their
 * expected shapes, never the model's raw object.
 */
import { describe, it, expect } from 'vitest';
import { normalizeBrandFacts } from '../../apps/api/src/lib/ai/brand-facts';

describe('normalizeBrandFacts', () => {
  it('keeps the six prompted keys in their expected shapes', () => {
    expect(
      normalizeBrandFacts({
        location: 'Kuwait',
        region: 'GCC',
        currency: 'KWD',
        languages: ['Arabic', 'English'],
        keyCategories: ['Nuts'],
        contactMethods: ['email'],
      })
    ).toEqual({
      location: 'Kuwait',
      region: 'GCC',
      currency: 'KWD',
      languages: ['Arabic', 'English'],
      keyCategories: ['Nuts'],
      contactMethods: ['email'],
    });
  });

  it('drops nested objects, nulls and unknown keys instead of persisting them', () => {
    expect(
      normalizeBrandFacts({
        location: { city: 'Kuwait City' },
        currency: null,
        address: { line1: 'x' },
        contactMethods: [{ type: 'email', value: 'x@y.com' }, 'whatsapp'],
        languages: 'Arabic',
      })
    ).toEqual({ contactMethods: ['whatsapp'] });
  });

  it('returns null when nothing usable is left (the sweep then skips the store)', () => {
    expect(normalizeBrandFacts({ address: {} })).toBeNull();
    expect(normalizeBrandFacts([])).toBeNull();
    expect(normalizeBrandFacts('text')).toBeNull();
  });
});

describe('the brand-facts sweep persists the normalized object', () => {
  it('bulk-ai-geo writes aboutJson only from normalizeBrandFacts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-geo.ts'),
      'utf8'
    );
    expect(src).toContain('normalizeBrandFacts(JSON.parse(raw))');
    expect(src).toContain('data: { aboutJson: facts }');
    expect(src).not.toContain('data: { aboutJson: parsed }');
  });
});
