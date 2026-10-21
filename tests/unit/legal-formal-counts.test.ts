/**
 * Review I6 (2026-10-16): legal text stays formal (Ruling FU46-Y02b), counts included. The
 * returns-policy body and the terms sentence count days with the formal table (`DAYS_FORMAL`:
 * "١٤ يومًا"), and only inside the legal fences; shopper sentences keep the Egyptian `DAYS`
 * ("١٤ يوم"). One helper, two tables.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countText, DAYS_FORMAL } from '../../apps/web/src/lib/plural';
import {
  returnPolicyCopy,
  termsReturnSentence,
  faqReturnAnswer,
} from '../../apps/web/src/lib/return-policy-text';

const ROOT = join(__dirname, '../..');

describe('formal day counts in legal text (I6)', () => {
  it('DAYS_FORMAL declines the formal way', () => {
    expect(countText('ar', 14, DAYS_FORMAL)).toBe('14 يومًا');
    expect(countText('ar', 2, DAYS_FORMAL)).toBe('يومين');
    expect(countText('ar', 3, DAYS_FORMAL)).toBe('3 أيام');
    expect(countText('ar', 100, DAYS_FORMAL)).toBe('100 يوم');
  });

  it('the returns-policy body and the terms sentence read "14 يومًا"; the FAQ answer stays Egyptian', () => {
    expect(returnPolicyCopy(14, 'ar').body).toContain('خلال 14 يومًا من تاريخ التوصيل');
    expect(returnPolicyCopy(14, 'ar').title).toBe('سياسة الإرجاع خلال 14 يومًا');
    expect(termsReturnSentence(14, 'ar')).toContain('خلال 14 يومًا من التوصيل');
    expect(faqReturnAnswer(14, 'ar')).toContain('خلال 14 يوم ');
  });

  it('DAYS_FORMAL is used only inside a legal-register fence', () => {
    const src = readFileSync(join(ROOT, 'apps/web/src/lib/return-policy-text.ts'), 'utf8');
    const start = src.indexOf('legal-register:start');
    const end = src.indexOf('legal-register:end');
    const uses = [...src.matchAll(/formalDaysPhrase\(/g)].map(m => m.index ?? 0);
    expect(uses.length).toBeGreaterThan(1);
    for (const at of uses.slice(1)) expect(at > start && at < end, String(at)).toBe(true);
  });
});
