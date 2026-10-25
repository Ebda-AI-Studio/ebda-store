import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COPY } from '../../apps/marketing/src/lib/content';

/**
 * LEGAL-1: the published Ebda WhatsApp legal pages must equal their source (ebda-whatsapp docs/legal) minus the
 * review-pending comments and markdown markup. The source is vendored verbatim in apps/marketing/legal-source/ by
 * `node apps/marketing/scripts/import-wa-legal.mjs <docs/legal>` (re-run it whenever the source changes; it also
 * regenerates src/lib/legal-wa-*.ts). The comparison is on the word sequence, so a clause edited or dropped in
 * either copy fails here; it cannot drift silently.
 */
const ROOT = path.resolve(__dirname, '../../apps/marketing/legal-source');
const DOCS = [
  ['terms', 'waTerms'],
  ['privacy', 'waPrivacy'],
  ['dpa', 'waDpa'],
] as const;
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

describe('published Ebda WhatsApp legal pages equal their vendored source', () => {
  for (const lang of ['ar', 'en'] as const)
    for (const [file, key] of DOCS) {
      it(`${lang} whatsapp-${file}`, () => {
        const raw = readFileSync(path.join(ROOT, lang, `whatsapp-${file}.md`), 'utf8');
        const doc = COPY[lang].legalPages[key];
        const overview = lang === 'ar' ? 'نظرة عامة' : 'Overview';
        const published = tokens(
          [doc.title, ...doc.sections.flatMap(s => [s.h === overview ? '' : s.h, ...s.p])].join(
            '\n'
          )
        );
        expect(published).toEqual(sourceTokens(raw));
        expect(doc.meta?.publishedAt).toBe(/^updated:\s*(\S+)/m.exec(raw)?.[1]);
        expect(JSON.stringify(doc)).not.toMatch(/PENDING|<!--/);
      });
    }

  it('negative control: dropping one word from the source is detected', () => {
    const raw = readFileSync(path.join(ROOT, 'en', 'whatsapp-terms.md'), 'utf8');
    expect(sourceTokens(raw.replace('Your account', 'Account'))).not.toEqual(sourceTokens(raw));
  });

  it('the 6.4.1 package clause is published', () => {
    expect(JSON.stringify(COPY.en.legalPages.waTerms)).toContain('6.4.1');
    expect(JSON.stringify(COPY.ar.legalPages.waTerms)).toContain('6.4.1');
  });
});
