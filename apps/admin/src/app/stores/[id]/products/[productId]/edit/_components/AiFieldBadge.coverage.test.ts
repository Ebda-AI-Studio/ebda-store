import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression for #1577: `AiFieldBadge` (AI provenance chip + "Switch to AI"
 * hand-back) rendered beside every AI-writable field EXCEPT the English
 * `name` and `description` — even though both are bidirectional
 * AI_AUTOFILL_FIELDS entries (`packages/shared/src/types/ai-autofill.ts`)
 * that the autopilot can silently overwrite from the Arabic sibling. A
 * merchant who hand-edited the English name had no visible sign it was
 * AI-owned and no hand-back control, unlike every other AI-writable field on
 * the same form.
 *
 * Asserts on source text (this page has no test-friendly render harness —
 * see ai-field-badge coverage pattern used for `checkout-error-code-coverage`)
 * rather than rendering: it proves the badge markup exists for `name` and
 * `description`, not that it paints correctly — that is a visual/manual
 * concern, this is "was the sibling-field fix forgotten again".
 */
const source = readFileSync(join(__dirname, '../page.tsx'), 'utf-8');

describe('EditProductPage AiFieldBadge coverage (#1577)', () => {
  const badgedFields = [...source.matchAll(/<AiFieldBadge\s+field="([a-zA-Z]+)"/g)].map(m => m[1]);

  it('shows the AI provenance badge for the English name field', () => {
    expect(badgedFields).toContain('name');
  });

  it('shows the AI provenance badge for the English description field', () => {
    expect(badgedFields).toContain('description');
  });

  it('still shows the badge for every previously-covered AI field', () => {
    for (const field of ['nameAr', 'descriptionAr', 'excerpt', 'excerptAr']) {
      expect(badgedFields).toContain(field);
    }
  });
});
