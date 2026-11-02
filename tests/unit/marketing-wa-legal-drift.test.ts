import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COPY } from '../../apps/marketing/src/lib/content';

/**
 * LEGAL-1: the published Ebda Chat legal pages must equal their source (ebda-whatsapp docs/legal) minus the
 * review-pending comments and markdown markup. The source is vendored verbatim in apps/marketing/legal-source/ by
 * `node apps/marketing/scripts/import-wa-legal.mjs <docs/legal>` (re-run it whenever the source changes; it also
 * regenerates src/lib/legal-wa-*.ts). The comparison is on the word sequence, so a clause edited or dropped in
 * either copy fails here (sources verified byte-identical at ebda-whatsapp main bb3e9f0 (WA PR #25), 2026-10-26); it cannot drift silently. PINNED_SHA256 pins the vendored files to the exact versions the
 * WhatsApp session published: when they ship a new text, re-import and update the hashes together.
 */
const ROOT = path.resolve(__dirname, '../../apps/marketing/legal-source');
const DOCS = [
  ['terms', 'waTerms'],
  ['privacy', 'waPrivacy'],
  ['dpa', 'waDpa'],
] as const;
const PINNED_SHA256: Record<string, string> = {
  'ar/whatsapp-terms': '619e3006dd2a546ce1eca8dfd0c05a289a4c9b642748bb92a24ca71f8a2ffbfe',
  'ar/whatsapp-privacy': '74f928d590d12b99afca3e31f1f12a7db97072943a4abab2f3d8f57c6cb54a95',
  'ar/whatsapp-dpa': 'f14f2ae4a578ab9a2ba0ddece99562358653436d1585eb622a55580816a019a7',
  'en/whatsapp-terms': '1710565cf245d8e01cebc2f127ce8c8a88af2900965c5a5c1a37998190d947d7',
  'en/whatsapp-privacy': '490d07bd087229ad7b9edeade7aa340c3d83e445dcf6e679da34bf10b57f4d2c',
  'en/whatsapp-dpa': '802870620cf528c6179124df7916231f5c1aa4956f76829b7091be507c33c1c9',
};
const PREVAILS = /^(Arabic version prevails\.|النسخة العربية هي الحاكمة\.)$/;
const tokens = (t: string) => t.match(/[\p{L}\p{N}]+/gu) ?? [];

function sourceTokens(raw: string): string[] {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '');
  return tokens(
    body
      .split('\n')
      .filter(l => !PREVAILS.test(l.trim()))
      .join('\n')
  );
}

describe('published Ebda Chat legal pages equal their vendored source', () => {
  for (const lang of ['ar', 'en'] as const)
    for (const [file, key] of DOCS) {
      it(`${lang} whatsapp-${file}`, () => {
        const raw = readFileSync(path.join(ROOT, lang, `whatsapp-${file}.md`), 'utf8');
        const doc = COPY[lang].legalPages[key];
        const overview = lang === 'ar' ? 'نظرة عامة' : 'Overview';
        const MARK =
          lang === 'ar' ? '[مبدئي، قيد المراجعة القانونية]' : '[Provisional, under legal review]';
        const pending = (raw.match(/<!--\s*PENDING LEGAL REVIEW/g) ?? []).length;
        const published = tokens(
          [doc.title, ...doc.sections.flatMap(s => [s.h === overview ? '' : s.h, ...s.p])]
            .join('\n')
            .split(MARK)
            .join('')
        );
        expect(published).toEqual(sourceTokens(raw));
        // DOC-3: every clause the source marks PENDING LEGAL REVIEW is published visibly provisional, never as final
        const allText = doc.sections.flatMap(s => s.p).join('\n');
        expect(allText.split(MARK).length - 1, 'one visible marker per pending clause').toBe(
          pending
        );
        if (pending)
          expect(
            doc.note,
            'a document with provisional clauses says so under its title'
          ).toBeTruthy();
        expect(doc.meta?.publishedAt).toBe(/^updated:\s*(\S+)/m.exec(raw)?.[1]);
        expect(JSON.stringify(doc)).not.toMatch(/PENDING|<!--/); // the raw HTML comment never reaches the page
      });
    }

  it('the vendored source is the exact file the WhatsApp session signed off (pinned sha256)', () => {
    for (const [name, sha] of Object.entries(PINNED_SHA256))
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(ROOT, `${name}.md`)))
          .digest('hex'),
        name
      ).toBe(sha);
  });

  it('negative control: dropping one word from the source is detected', () => {
    const raw = readFileSync(path.join(ROOT, 'en', 'whatsapp-terms.md'), 'utf8');
    expect(sourceTokens(raw.replace('Your account', 'Account'))).not.toEqual(sourceTokens(raw));
  });

  it('the 6.4.1 package clause is published', () => {
    expect(JSON.stringify(COPY.en.legalPages.waTerms)).toContain('6.4.1');
    expect(JSON.stringify(COPY.ar.legalPages.waTerms)).toContain('6.4.1');
  });
});
