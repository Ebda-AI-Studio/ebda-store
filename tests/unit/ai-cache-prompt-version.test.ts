/**
 * Review I4 (2026-10-16): the 7-day AI suggestion cache keyed only on the input, so after the
 * prompt changed (Egyptian register, FU46-Y02d) a merchant asking again got the cached MSA
 * answer for up to a week. Every AI cache key now carries the instruction it was produced with.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: {} }));

const SRC = readFileSync(join(__dirname, '../../apps/api/src/services/ai.service.ts'), 'utf8');

describe('AI cache keys carry the prompt version (I4)', () => {
  it('a different instruction gives a different key for the same input', async () => {
    const { cacheKey } = await import('../../apps/api/src/services/ai.service');
    const input = { storeId: 's1', entityName: 'Ring' };
    expect(cacheKey('seo', input, 'v1 prompt')).not.toBe(cacheKey('seo', input, 'v2 prompt'));
    expect(cacheKey('seo', input, 'v1 prompt')).toBe(cacheKey('seo', input, 'v1 prompt'));
  });

  it('every cacheKey call in ai.service passes its module-level instruction', () => {
    const calls = [...SRC.matchAll(/cacheKey\(\s*'(\w+)',[\s\S]*?\)\s*;/g)].map(m => m[0]);
    expect(calls.length).toBe(5); // translate, seo, section, campaign, categorize
    for (const c of calls) expect(c, c).toMatch(/,\s*[A-Z_]+_INSTRUCTION,?\s*\)\s*;$/);
  });

  it('the section copy (shopper-facing) asks for Egyptian Arabic too', () => {
    const at = SRC.indexOf('const SECTION_INSTRUCTION');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, SRC.indexOf(';', at))).toMatch(/EGYPTIAN_ARABIC_REGISTER/);
  });
});
