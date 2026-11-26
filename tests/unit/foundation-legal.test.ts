import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// F8 (Ruling FDN-LEGAL-1): the counsel-approved Chat legal texts and the VAT-0 clause live in the foundation (`legal/`), byte for byte, and the
// Store vendors them under packages/shared/src/foundation/legal. The marketing site publishes `apps/marketing/legal-source/{ar,en}` on ebda.app:
// those files must stay identical to the foundation's, so a clause can only change by a foundation tag + a re-vendor, never by a local edit.
// The vendored copy itself is pinned by foundation.lock.json (`ebda-foundation check`, tests/unit/foundation-parity.test.ts).
const ROOT = join(__dirname, '../..');
const VENDORED = join(ROOT, 'packages/shared/src/foundation/legal/whatsapp');
const PUBLISHED = join(ROOT, 'apps/marketing/legal-source');

describe('published Chat legal text = the foundation copy', () => {
  for (const lang of ['ar', 'en']) {
    it(`${lang}: same file set, same bytes`, () => {
      const v = readdirSync(join(VENDORED, lang)).sort();
      expect(v.length).toBeGreaterThan(0);
      expect(readdirSync(join(PUBLISHED, lang)).sort()).toEqual(v);
      for (const f of v)
        expect(
          readFileSync(join(PUBLISHED, lang, f)).equals(readFileSync(join(VENDORED, lang, f))),
          `${lang}/${f}`
        ).toBe(true);
    });
  }
});
