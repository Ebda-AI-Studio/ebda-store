/**
 * Review I6 (2026-10-16): legal text stays formal (Ruling FU46-Y02b), counts included. The
 * returns-policy body and the terms sentence count days with the formal table (`DAYS_FORMAL`:
 * "١٤ يومًا"), and only inside the legal fences; shopper sentences keep the Egyptian `DAYS`
 * ("١٤ يوم"). One helper, two tables.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { parseRel, findAll, callsTo } from './helpers/ts-ast';
import { countText, DAYS_FORMAL } from '../../apps/web/src/lib/plural';
import {
  returnPolicyCopy,
  termsReturnSentence,
  faqReturnAnswer,
} from '../../apps/web/src/lib/return-policy-text';

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
    // AST: the fence markers are real COMMENT tokens (a mention in prose or a string does not
    // open a fence) and the uses are real CALL nodes (a comment naming the helper is not a use).
    const sf = parseRel('apps/web/src/lib/return-policy-text.ts');
    const text = sf.getFullText();
    const fences = new Map<string, number>();
    const seen = new Set<number>();
    for (const node of findAll(sf, () => true)) {
      if (seen.has(node.pos)) continue;
      seen.add(node.pos);
      for (const c of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
        const m = text.slice(c.pos, c.end).match(/^\/\/\s*legal-register:(start|end)\b/);
        if (m) fences.set(m[1], c.pos);
      }
    }
    expect(fences.has('start') && fences.has('end'), 'legal-register fence markers moved').toBe(
      true
    );
    const uses = callsTo(sf, 'formalDaysPhrase').map(c => c.getStart());
    expect(uses.length).toBeGreaterThan(1);
    for (const at of uses)
      expect(at > fences.get('start')! && at < fences.get('end')!, String(at)).toBe(true);
  });
});
