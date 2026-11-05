import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Ebda Chat developer docs on docs.ebda.app/whatsapp/ equal their source (ebda-whatsapp docs/site/{ar,en}/whatsapp,
 * vendored verbatim in apps/docs/wa-source/ by `node apps/docs/scripts/import-wa-docs.mjs <docs/site>`). PINNED_SHA256 pins
 * each vendored file to the version the WhatsApp session published: when they ship new text, re-import and update the
 * hashes together. The word comparison fails if a published page differs from its source (link targets and the dropped H1 aside).
 */
const DOCS = path.resolve(__dirname, '../../apps/docs');
const PINNED_SHA256: Record<string, string> = {
  'ar/api.mdx': '92238e84525e4af151dc576a2f9e063defbfafb770fd67ccb2f87eb7ac9a7c6c',
  'ar/connect-your-number.mdx': '08ae3ec6abf3b5a60cfb44cc02b4cfbc718ec243a483fb9404fd5a2b65ed15ec',
  'ar/overview.mdx': '8b56c065ec55fabdf5e7a7eb58f301f5bdefcbd70ada336374ae1863fc7bd38f',
  'ar/webhooks.mdx': 'd002b89f7a7b019b70ddca09e3ee20159b9b0018e5587ff5890037594eb485e4',
  'en/api.mdx': 'fad209f2aa8995a685038427c32590ddd063595ef45b374a90450d58a0e76760',
  'en/connect-your-number.mdx': '94ae67eb9e43bf8cd4fe482604460b5a129c63cead2096b525557b3a0029d9e2',
  'en/overview.mdx': 'af31b0a9bc02396aad4d1afc3f77016ad086ce4fb94c4fd6a9001bfaa99d1e93',
  'en/webhooks.mdx': 'ae6add9b2e9b41bf71f31db1b581bdcc1198fecc1ebeebd0f33e8fd3cf3a52a0',
};
const tokens = (t: string) => t.match(/[\p{L}\p{N}]+/gu) ?? [];
const noTargets = (t: string) => t.replace(/\]\([^)]*\)/g, ']');
const body = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*# .*\n/, '');
// the importer labels an empty table header cell, which adds exactly one word per such table
const HEAD_LABEL = /^\| (Option|الخيار) \|/m;

describe('Ebda Chat docs equal their vendored source', () => {
  it('every vendored file is exactly the pinned version, and none is unpinned', () => {
    const found: string[] = [];
    for (const lang of ['ar', 'en'])
      for (const f of readdirSync(path.join(DOCS, 'wa-source', lang))) found.push(`${lang}/${f}`);
    expect(found.sort()).toEqual(Object.keys(PINNED_SHA256).sort());
    for (const [name, sha] of Object.entries(PINNED_SHA256))
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(DOCS, 'wa-source', name)))
          .digest('hex'),
        name
      ).toBe(sha);
  });

  for (const name of Object.keys(PINNED_SHA256)) {
    it(`${name}: the published page has the source's words`, () => {
      const [lang, file] = name.split('/');
      const src = readFileSync(path.join(DOCS, 'wa-source', name), 'utf8');
      const out = readFileSync(path.join(DOCS, 'content', 'whatsapp', lang, file), 'utf8');
      const published = tokens(noTargets(body(out)));
      const want = tokens(noTargets(body(src)));
      const label = HEAD_LABEL.exec(out) && !HEAD_LABEL.test(src) ? 1 : 0;
      expect(published.length - label).toBe(want.length);
      expect(
        label
          ? published.filter((_, i) => i !== published.indexOf(HEAD_LABEL.exec(out)![1]))
          : published
      ).toEqual(want);
      expect(out).not.toMatch(/^# /m);
    });
  }

  it('negative control: a dropped word is detected', () => {
    const src = readFileSync(path.join(DOCS, 'wa-source', 'en', 'api.mdx'), 'utf8');
    expect(tokens(body(src).replace('Authentication', ''))).not.toEqual(tokens(body(src)));
  });
});
