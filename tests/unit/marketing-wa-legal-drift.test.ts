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
  'ar/whatsapp-terms': 'c498024f8cc67030094f6a9c1a1e9b24f8e0aa9944125c5ecdc3ec8c07557f8c',
  'ar/whatsapp-privacy': '31ab82572623b3c2babf14894b46af9df9dc1d5aedc337c90ad1c4519b6f1e61',
  'ar/whatsapp-dpa': 'f094e4603a11de5c9d72ea0f0dca59f8d7921e4e30af6b642c6efe3563d65231',
  'en/whatsapp-terms': '83163a51b281fc7d9f697bf49ffa9f169bb1a416a4e4bf5ca8945968cbc6ebcd',
  'en/whatsapp-privacy': 'db96a6070a6d183cc2b59a031b5ba99c52f6d0c9b5738f9723d0107d9478622e',
  'en/whatsapp-dpa': '80c68806be3e678bfb2234b6302b72ce9e0e803e561f005aad0dfee99fee9324',
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
