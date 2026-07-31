import { describe, it, expect, vi } from 'vitest';

// ai.service pulls in Prisma/Redis/Gemini at import time; none of that is
// needed to exercise the pure validation layer.
vi.mock('@force/database', () => ({ prisma: {} }));
vi.mock('../../apps/api/src/services/redis.service', () => ({ redis: {} }));

import {
  seoSuggestionSchema,
  sectionContentSchema,
  categorizeSchema,
  parseAiJson,
} from '../../apps/api/src/services/ai.service';

/**
 * Regression tests for AI output validation.
 *
 * These schemas replaced hand-rolled `typeof x !== 'string'` chains. Those
 * chains DID check that each scalar was present and a string — the gaps were
 * narrower and are what these tests pin down:
 *   - array ELEMENT types (`Array.isArray(keywords)` accepted `[{}, 42]`)
 *   - the `confidence` enum (any string passed through to the admin UI)
 *   - `matches` being an array at all (a non-array threw out of `.filter`,
 *     surfacing as a 500 rather than a clean 502)
 *   - length bounds (nothing stopped a 50 KB title reaching the DB)
 */
describe('AI output schema validation', () => {
  const ctx = { storeId: 'store-1', kind: 'test' };

  describe('seoSuggestionSchema', () => {
    const valid = {
      title: 'Pecan Mix',
      titleAr: 'بيكان مشكل',
      description: 'A tasty mix.',
      descriptionAr: 'خليط لذيذ.',
      keywords: ['pecan', 'nuts'],
    };

    it('accepts a well-formed suggestion', () => {
      expect(seoSuggestionSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects non-string keyword elements (the gap the old check missed)', () => {
      // Array.isArray() was true here, so this used to pass straight through
      // and render as "[object Object]" in a meta tag.
      const bad = { ...valid, keywords: [{ kw: 'pecan' }, 42] };
      expect(seoSuggestionSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects an absurdly long title', () => {
      const bad = { ...valid, title: 'x'.repeat(50_000) };
      expect(seoSuggestionSchema.safeParse(bad).success).toBe(false);
    });

    it('still rejects a missing field, as before', () => {
      const { descriptionAr, ...bad } = valid;
      expect(seoSuggestionSchema.safeParse(bad).success).toBe(false);
    });
  });

  describe('categorizeSchema', () => {
    it('rejects a confidence value outside the enum', () => {
      const bad = { matches: [{ id: 'c1', confidence: 'extremely high' }] };
      expect(categorizeSchema.safeParse(bad).success).toBe(false);
    });

    it('accepts the three valid confidence levels', () => {
      const ok = {
        matches: [
          { id: 'c1', confidence: 'high' },
          { id: 'c2', confidence: 'medium' },
          { id: 'c3', confidence: 'low' },
        ],
      };
      expect(categorizeSchema.safeParse(ok).success).toBe(true);
    });

    it('rejects a non-array `matches` instead of throwing out of .filter', () => {
      expect(categorizeSchema.safeParse({ matches: 'nope' }).success).toBe(false);
    });
  });

  describe('parseAiJson', () => {
    it('maps non-JSON to a 502 AI_BAD_RESPONSE', () => {
      expect(() => parseAiJson(sectionContentSchema, 'not json at all', ctx)).toThrowError(
        expect.objectContaining({ statusCode: 502, code: 'AI_BAD_RESPONSE' })
      );
    });

    it('maps valid JSON of the WRONG SHAPE to the same 502', () => {
      // Previously this distinction was per-call-site and inconsistent.
      expect(() => parseAiJson(sectionContentSchema, '{"kicker":123}', ctx)).toThrowError(
        expect.objectContaining({ statusCode: 502, code: 'AI_BAD_RESPONSE' })
      );
    });

    it('returns the parsed value on success', () => {
      const raw = JSON.stringify({ kicker: 'A', kickerAr: 'ب', subtitle: 'S', subtitleAr: 'س' });
      expect(parseAiJson(sectionContentSchema, raw, ctx)).toEqual({
        kicker: 'A',
        kickerAr: 'ب',
        subtitle: 'S',
        subtitleAr: 'س',
      });
    });
  });
});
